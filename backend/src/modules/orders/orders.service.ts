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

  async checkout(input: CheckoutRequestInput, userId?: string) {
    // 1. Validate all cart items and modifiers server-side
    const validatedItems: any[] = [];
    let subtotalInPaise = 0;

    for (const item of input.items) {
      const validItem = await this.menuService.validateCartItem(item);
      validatedItems.push(validItem);
      subtotalInPaise += validItem.totalPriceInPaise;
    }

    const payloadHash = this.computePayloadFingerprint(input.items, subtotalInPaise);

    // 2. Idempotency Check with Ownership & Payload Fingerprint Verification
    const existingOrder = await this.prisma.order.findUnique({
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

    if (existingOrder) {
      // Ownership check: Prevent customer A from accessing customer B's order via idempotency key
      if (existingOrder.userId && userId && existingOrder.userId !== userId) {
        const err: any = new Error(
          'Idempotency key belongs to another customer account'
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
        err.statusCode = 422;
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
      // Problem 3A Fix: Concurrent submission race condition handling.
      // If two requests race with the same idempotencyKey, the second hits unique constraint (P2002).
      // Catch P2002 and return the winning order cleanly with 200 OK instead of throwing 500!
      if (
        err.code === 'P2002' ||
        err.message?.includes('idempotencyKey') ||
        err.message?.includes('Unique constraint failed')
      ) {
        const winningOrder = await this.prisma.order.findUnique({
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

        if (winningOrder) {
          return {
            isDuplicateSubmission: true,
            order: winningOrder,
          };
        }
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
    if (actor.role === Role.CUSTOMER) {
      // Customers can ONLY cancel their own order, and only when still in PENDING_PAYMENT
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

    // C. Atomic Status Transition + Inventory Restoration if Cancelled
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
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
}
