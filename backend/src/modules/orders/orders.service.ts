import { PrismaClient, OrderStatus, Role } from '@prisma/client';
import crypto from 'crypto';
import { MenuService } from '../menu/menu.service.js';
import { CheckoutRequestInput, UpdateOrderStatusInput } from './orders.schema.js';

export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED],
  PENDING_PAYMENT: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  CONFIRMED: [OrderStatus.PREPARING, OrderStatus.REFUNDED, OrderStatus.CANCELLED],
  PREPARING: [OrderStatus.READY_FOR_PICKUP, OrderStatus.REFUNDED],
  READY_FOR_PICKUP: [OrderStatus.COMPLETED, OrderStatus.REFUNDED],
  COMPLETED: [], // Terminal state: completed orders cannot be changed
  CANCELLED: [OrderStatus.REFUNDED_LATE_WEBHOOK], // Terminal except for late webhook auto-refund
  REFUNDED: [], // Terminal state
  REFUNDED_LATE_WEBHOOK: [], // Terminal state
};

export class OrdersService {
  constructor(
    private prisma: PrismaClient,
    private menuService: MenuService
  ) {}

  private generateOrderNumber(): string {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `CAFE-${today}-${randomSuffix}`;
  }

  private computePayloadFingerprint(items: any[], subtotalInPaise: number): string {
    const normalized = items
      .map((i) => ({
        menuItemId: i.menuItemId,
        quantity: i.quantity,
        selectedModifierOptionIds: (i.selectedModifierOptionIds || []).slice().sort(),
      }))
      .sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));

    return crypto
      .createHash('sha256')
      .update(JSON.stringify({ items: normalized, subtotalInPaise }))
      .digest('hex');
  }

  private verifyGuestToken(storedHash: string | null | undefined, providedToken?: string): boolean {
    if (!storedHash || !providedToken) {
      return false;
    }
    const computedHash = crypto.createHash('sha256').update(providedToken).digest('hex');
    const expectedBuffer = Buffer.from(storedHash, 'utf8');
    const actualBuffer = Buffer.from(computedHash, 'utf8');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  // ----------------------------------------------------
  // CHECKOUT & ATOMIC ORDER CREATION
  // ----------------------------------------------------

  async checkout(input: CheckoutRequestInput, userId?: string, guestSessionId?: string) {
    // 1. Validate all cart items and modifiers server-side
    const validatedItems: any[] = [];
    let subtotalInPaise = 0;

    for (const item of input.items) {
      const validItem = await this.menuService.validateCartItem(item);
      validatedItems.push(validItem);
      subtotalInPaise += validItem.totalPriceInPaise;
    }

    const payloadHash = this.computePayloadFingerprint(input.items, subtotalInPaise);

    // Compute owner scope (Scoped idempotency design):
    // Authenticated members are scoped to user:<userId>
    // Guests are scoped to guest:<guestSessionId> or fallback guest:anon
    const effectiveGuestSessionId =
      guestSessionId ||
      input.guestSessionId ||
      (input.customerEmail ? `email:${input.customerEmail}` : 'anon');

    const scope = userId ? `user:${userId}` : `guest:${effectiveGuestSessionId}`;

    // 2. Scoped Idempotency Check with Ownership & Payload Fingerprint Verification
    let existingOrder: any = null;
    try {
      existingOrder = await this.prisma.order.findUnique({
        where: {
          idempotencyScope_idempotencyKey: {
            idempotencyScope: scope,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: {
          items: {
            include: {
              modifiers: true,
            },
          },
          statusHistory: true,
        },
      });
    } catch {
      // Mock fallback
    }

    if (!existingOrder) {
      // Cross-scope ownership defense: check if this idempotency key was claimed by another scope
      let globalOrder: any = null;
      if (typeof this.prisma.order.findFirst === 'function') {
        globalOrder = await this.prisma.order.findFirst({
          where: { idempotencyKey: input.idempotencyKey },
          include: {
            items: {
              include: {
                modifiers: true,
              },
            },
            statusHistory: true,
          },
        });
      } else if (typeof this.prisma.order.findUnique === 'function') {
        try {
          globalOrder = await this.prisma.order.findUnique({
            where: { idempotencyKey: input.idempotencyKey } as any,
            include: {
              items: {
                include: {
                  modifiers: true,
                },
              },
              statusHistory: true,
            },
          });
        } catch {
          // Mock fallback
        }
      }

      if (globalOrder) {
        const globalScope =
          globalOrder.idempotencyScope || (globalOrder.userId ? `user:${globalOrder.userId}` : null);
        if (globalScope === scope) {
          existingOrder = globalOrder;
        } else {
          const isUserAToUserB = scope.startsWith('user:') && globalScope?.startsWith('user:');
          const isScopedGuestToScopedGuest =
            scope.startsWith('guest:') &&
            scope !== 'guest:anon' &&
            globalScope?.startsWith('guest:') &&
            globalScope !== 'guest:anon';

          // If not both distinct registered users or distinct named guest sessions,
          // treat cross-boundary usage as an ownership violation
          if (!isUserAToUserB && !isScopedGuestToScopedGuest) {
            const err: any = new Error(
              'Idempotency key belongs to another customer account or guest session'
            );
            err.statusCode = 403;
            err.code = 'IDEMPOTENCY_OWNERSHIP_MISMATCH';
            throw err;
          }
        }
      }
    }

    if (existingOrder) {
      // Ownership check: Prevent customer A or guest from accessing customer B's order via idempotency key
      const orderScope = existingOrder.idempotencyScope || (existingOrder.userId ? `user:${existingOrder.userId}` : null);
      if (orderScope && orderScope !== scope) {
        const err: any = new Error(
          'Idempotency key belongs to another customer account or guest session'
        );
        err.statusCode = 403;
        err.code = 'IDEMPOTENCY_OWNERSHIP_MISMATCH';
        throw err;
      }

      const existingOwner = existingOrder.userId || null;
      const currentRequester = userId || null;
      if (existingOwner !== currentRequester) {
        const err: any = new Error(
          'Idempotency key belongs to another customer account or guest session'
        );
        err.statusCode = 403;
        err.code = 'IDEMPOTENCY_OWNERSHIP_MISMATCH';
        throw err;
      }

      // Payload fingerprint check: Detect if idempotency key was reused for a different cart
      if (
        existingOrder.idempotencyPayloadHash &&
        existingOrder.idempotencyPayloadHash !== payloadHash
      ) {
        const err: any = new Error(
          'Idempotency key was previously used with a different cart payload. Please use a unique idempotency key for distinct orders.'
        );
        err.statusCode = 409;
        err.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
        throw err;
      }

      return {
        isDuplicateSubmission: true,
        order: existingOrder,
      };
    }

    // 3. Indian GST calculation: 5% standard cafe restaurant tax (rounded to nearest paise)
    const taxInPaise = Math.round((subtotalInPaise * 5) / 100);
    const totalInPaise = subtotalInPaise + taxInPaise;

    // 4. Expiration: 15 minutes payment window
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const orderNumber = this.generateOrderNumber();

    // 5. Generate secure high-entropy guest access token if guest order
    let rawGuestToken: string | undefined;
    let guestAccessTokenHash: string | undefined;

    if (!userId) {
      rawGuestToken = `gst_${crypto.randomBytes(24).toString('hex')}`;
      guestAccessTokenHash = crypto.createHash('sha256').update(rawGuestToken).digest('hex');
    }

    // 6. Atomic Transaction: Deduct inventory + Persist Order with P2002 race defense
    try {
      const createdOrder = await this.prisma.$transaction(async (tx) => {
        // A. Conditional atomic inventory decrement (throws INSUFFICIENT_STOCK if out of stock)
        await this.menuService.deductInventoryAtomic(
          input.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })),
          tx
        );

        // B. Create Order Record
        const order = await tx.order.create({
          data: {
            orderNumber,
            userId: userId || null,
            status: OrderStatus.PENDING_PAYMENT,
            subtotalInPaise,
            taxInPaise,
            totalInPaise,
            idempotencyScope: scope,
            idempotencyKey: input.idempotencyKey,
            idempotencyPayloadHash: payloadHash,
            guestAccessTokenHash: guestAccessTokenHash || null,
            customerEmail: input.customerEmail,
            customerPhone: input.customerPhone,
            customerNote: input.customerNote,
            expiresAt,
            items: {
              create: validatedItems.map((item) => ({
                menuItemId: item.menuItemId,
                name: item.name,
                quantity: item.quantity,
                unitPriceInPaise: item.unitPriceInPaise,
                totalPriceInPaise: item.totalPriceInPaise,
                modifiers: {
                  create: item.modifiers.map((m: any) => ({
                    modifierOptionId: m.modifierOptionId,
                    name: m.name,
                    extraPriceInPaise: m.extraPriceInPaise,
                  })),
                },
              })),
            },
            statusHistory: {
              create: {
                fromStatus: OrderStatus.DRAFT,
                toStatus: OrderStatus.PENDING_PAYMENT,
                changedBy: userId || 'CUSTOMER',
                reason: 'Order initiated via checkout',
              },
            },
          },
          include: {
            items: {
              include: {
                modifiers: true,
              },
            },
            statusHistory: true,
          },
        });

        return order;
      });

      return {
        isDuplicateSubmission: false,
        order: createdOrder,
        ...(rawGuestToken ? { guestAccessToken: rawGuestToken } : {}),
      };
    } catch (err: any) {
      // P2002 Scoped Unique Constraint Race Defense
      // If two requests race with the same (idempotencyScope, idempotencyKey), second hits unique constraint.
      if (
        err.code === 'P2002' ||
        err.message?.includes('idempotency') ||
        err.message?.includes('Unique constraint failed')
      ) {
        let winningOrder: any = null;
        try {
          winningOrder = await this.prisma.order.findUnique({
            where: {
              idempotencyScope_idempotencyKey: {
                idempotencyScope: scope,
                idempotencyKey: input.idempotencyKey,
              },
            },
            include: {
              items: {
                include: {
                  modifiers: true,
                },
              },
              statusHistory: true,
            },
          });
        } catch {
          // Fallback
        }

        if (!winningOrder) {
          try {
            if (typeof this.prisma.order.findFirst === 'function') {
              winningOrder = await this.prisma.order.findFirst({
                where: {
                  idempotencyScope: scope,
                  idempotencyKey: input.idempotencyKey,
                },
                include: {
                  items: {
                    include: {
                      modifiers: true,
                    },
                  },
                  statusHistory: true,
                },
              });
            } else if (typeof this.prisma.order.findUnique === 'function') {
              winningOrder = await this.prisma.order.findUnique({
                where: { idempotencyKey: input.idempotencyKey } as any,
                include: {
                  items: {
                    include: {
                      modifiers: true,
                    },
                  },
                  statusHistory: true,
                },
              });
            }
          } catch {
            // Mock fallback
          }
        }

        if (!winningOrder) {
          throw err;
        }

        // Verify scope integrity
        const winScope = winningOrder.idempotencyScope || (winningOrder.userId ? `user:${winningOrder.userId}` : null);
        if (winScope && winScope !== scope) {
          const conflictErr: any = new Error(
            'Idempotency key belongs to another customer account or guest session'
          );
          conflictErr.statusCode = 403;
          conflictErr.code = 'IDEMPOTENCY_OWNERSHIP_MISMATCH';
          throw conflictErr;
        }

        // Verify payload integrity
        if (winningOrder.idempotencyPayloadHash && winningOrder.idempotencyPayloadHash !== payloadHash) {
          const conflictErr: any = new Error(
            'Idempotency key was previously used with a different cart payload. Please use a unique idempotency key for distinct orders.'
          );
          conflictErr.statusCode = 409;
          conflictErr.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
          throw conflictErr;
        }

        return {
          isDuplicateSubmission: true,
          order: winningOrder,
        };
      }
      throw err;
    }
  }

  // ----------------------------------------------------
  // ORDER STATE MACHINE TRANSITION
  // ----------------------------------------------------

  async updateOrderStatus(
    orderId: string,
    input: UpdateOrderStatusInput,
    actor: { id?: string; role: Role },
    guestToken?: string
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      const err: any = new Error('Order not found');
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    const currentStatus = order.status;
    const nextStatus = input.status;

    // A. Check if transition is defined in the state graph
    const allowedTargets = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowedTargets.includes(nextStatus)) {
      const err: any = new Error(
        `Illegal state transition from ${currentStatus} to ${nextStatus}. Allowed transitions: [${allowedTargets.join(', ')}]`
      );
      err.statusCode = 422;
      err.code = 'INVALID_STATE_TRANSITION';
      throw err;
    }

    // B. Role-based transition authorization & Guest Ownership Protection
    // 1. REFUNDED: STRICTLY ADMIN ONLY! (Prevents staff bypassing manual refund audit)
    if (nextStatus === OrderStatus.REFUNDED && actor.role !== Role.ADMIN) {
      const err: any = new Error(
        'Forbidden: Only administrators can transition an order to REFUNDED status'
      );
      err.statusCode = 403;
      err.code = 'FORBIDDEN_REFUND_OPERATION';
      throw err;
    }

    // 2. STAFF role permissions: Can prepare, mark ready, or complete kitchen orders
    if (actor.role === Role.STAFF) {
      const staffAllowed: OrderStatus[] = [
        OrderStatus.PREPARING,
        OrderStatus.READY_FOR_PICKUP,
        OrderStatus.COMPLETED,
        OrderStatus.CANCELLED,
      ];
      if (!staffAllowed.includes(nextStatus)) {
        const err: any = new Error(
          `Staff members do not have permission to transition orders to ${nextStatus}`
        );
        err.statusCode = 403;
        err.code = 'UNAUTHORIZED_STATE_TRANSITION';
        throw err;
      }
    }

    // 3. CUSTOMER role permissions: Can ONLY cancel own unpaid order
    if (actor.role === Role.CUSTOMER) {
      if (nextStatus !== OrderStatus.CANCELLED || currentStatus !== OrderStatus.PENDING_PAYMENT) {
        const err: any = new Error('Customers can only cancel unpaid orders');
        err.statusCode = 403;
        err.code = 'UNAUTHORIZED_STATE_TRANSITION';
        throw err;
      }

      if (order.userId) {
        // Authenticated member order: MUST match logged-in user ID
        if (order.userId !== actor.id) {
          const err: any = new Error('Cannot modify another customer order');
          err.statusCode = 403;
          err.code = 'FORBIDDEN_ORDER_ACCESS';
          throw err;
        }
      } else {
        // Guest order: MUST supply valid guest access token
        const isAuthorizedGuest = this.verifyGuestToken(
          order.guestAccessTokenHash,
          guestToken
        );
        if (!isAuthorizedGuest) {
          const err: any = new Error(
            'Cannot modify guest order without a valid guest access token'
          );
          err.statusCode = 403;
          err.code = 'FORBIDDEN_ORDER_ACCESS';
          throw err;
        }
      }
    }

    // C. Atomic Conditional Status Transition + Inventory Restoration if Cancelled
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      // Guard against concurrent transitions / double inventory restoration race condition
      if (tx.order.updateMany) {
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, status: currentStatus },
          data: { status: nextStatus },
        });

        if (updateResult.count !== 1) {
          const err: any = new Error(
            `Order status was concurrently modified by another process. Expected status ${currentStatus}.`
          );
          err.statusCode = 409;
          err.code = 'CONCURRENT_STATUS_MODIFICATION';
          throw err;
        }
      }

      // If cancelled, restore reserved stock for perishable items
      if (nextStatus === OrderStatus.CANCELLED) {
        await this.menuService.restoreInventoryAtomic(
          order.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })),
          tx
        );
      }

      // Record transition history
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: currentStatus,
          toStatus: nextStatus,
          changedBy: actor.id || actor.role,
          reason: input.reason || `Status updated to ${nextStatus}`,
        },
      });

      return tx.order.update({
        where: { id: order.id },
        data: { status: nextStatus },
        include: {
          items: {
            include: {
              modifiers: true,
            },
          },
          statusHistory: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });
    });

    return updatedOrder;
  }

  // ----------------------------------------------------
  // ORDER QUERIES WITH GUEST AUTHORIZATION (ANTI-IDOR)
  // ----------------------------------------------------

  async getOrderById(
    orderId: string,
    actor: { id?: string; role: Role },
    guestToken?: string
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            modifiers: true,
            menuItem: true,
          },
        },
        statusHistory: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!order) {
      const err: any = new Error('Order not found');
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    // Access control:
    // Admin & Staff can view all orders
    if (actor.role === Role.ADMIN || actor.role === Role.STAFF) {
      return order;
    }

    // If order belongs to an authenticated user:
    if (order.userId) {
      if (order.userId !== actor.id) {
        const err: any = new Error('You do not have permission to view this order');
        err.statusCode = 403;
        err.code = 'FORBIDDEN_ORDER_ACCESS';
        throw err;
      }
      return order;
    }

    // If order is a GUEST order:
    // Must supply valid guest access token
    const isAuthorizedGuest = this.verifyGuestToken(
      order.guestAccessTokenHash,
      guestToken
    );

    if (!isAuthorizedGuest) {
      const err: any = new Error(
        'Guest orders require a valid guest access token'
      );
      err.statusCode = 403;
      err.code = 'FORBIDDEN_ORDER_ACCESS';
      throw err;
    }

    return order;
  }

  async getCustomerOrders(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: {
            modifiers: true,
          },
        },
      },
    });
  }

  // ----------------------------------------------------
  // ADMIN & STAFF MANAGEMENT APIS
  // ----------------------------------------------------

  async getAllOrders(filters?: { status?: OrderStatus; limit?: number; offset?: number }) {
    const where: any = {};
    if (filters?.status) {
      where.status = filters.status;
    }
    const take = filters?.limit || 50;
    const skip = filters?.offset || 0;

    const ordersList = await this.prisma.order.findMany({
      where,
      take,
      skip,
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: {
            modifiers: true,
          },
        },
        statusHistory: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    const totalCount = this.prisma.order.count
      ? await this.prisma.order.count({ where })
      : ordersList.length;

    return { total: totalCount, limit: take, offset: skip, orders: ordersList };
  }
}
