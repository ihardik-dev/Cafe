import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { OrderStatus, Role } from '@prisma/client';
import crypto from 'crypto';
import { buildApp } from '../src/server.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';
import { PaymentsService } from '../src/modules/payments/payments.service.js';
import { ReservationsService } from '../src/modules/reservations/reservations.service.js';

function createMockPrisma() {
  const categories: Map<string, any> = new Map();
  const menuItems: Map<string, any> = new Map();
  const inventoryItems: Map<string, any> = new Map();
  const orders: Map<string, any> = new Map();
  const orderItems: Map<string, any> = new Map();
  const orderStatusHistory: Map<string, any> = new Map();
  const inboundEvents: Map<string, any> = new Map();
  const refundAudits: Map<string, any> = new Map();
  const tables: Map<string, any> = new Map();
  const reservations: Map<string, any> = new Map();
  const holds: Map<string, any> = new Map();
  const users: Map<string, any> = new Map();

  let isLocked = false;
  const queue: (() => void)[] = [];
  const acquireLock = async () => {
    if (isLocked) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    isLocked = true;
  };
  const releaseLock = () => {
    if (queue.length > 0) {
      queue.shift()!();
    } else {
      isLocked = false;
    }
  };

  const client: any = {
    category: {
      async create({ data }: any) {
        const id = data.id || `cat-${Date.now()}`;
        const c = { id, ...data };
        categories.set(id, c);
        return { ...c };
      },
    },
    menuItem: {
      async create({ data }: any) {
        const id = data.id || `item-${Date.now()}-${Math.random()}`;
        const item = { id, ...data, isAvailable: data.isAvailable ?? true };
        menuItems.set(id, item);
        return { ...item };
      },
      async findUnique({ where, include }: any) {
        const item = menuItems.get(where.id);
        if (!item) return null;
        const res: any = { ...item };
        if (include?.inventory) {
          for (const inv of inventoryItems.values()) {
            if (inv.menuItemId === item.id) {
              res.inventory = { ...inv };
              break;
            }
          }
        }
        if (include?.modifierGroups) {
          res.modifierGroups = [];
        }
        return res;
      },
    },
    inventoryItem: {
      async create({ data }: any) {
        const id = data.id || `inv-${Date.now()}`;
        const inv = { id, ...data };
        inventoryItems.set(id, inv);
        return { ...inv };
      },
      async findUnique({ where }: any) {
        for (const inv of inventoryItems.values()) {
          if (inv.menuItemId === where.menuItemId || inv.id === where.id) {
            return { ...inv };
          }
        }
        return null;
      },
      async update({ where, data }: any) {
        let targetId = where.id;
        if (!targetId && where.menuItemId) {
          for (const inv of inventoryItems.values()) {
            if (inv.menuItemId === where.menuItemId) {
              targetId = inv.id;
              break;
            }
          }
        }
        const inv = inventoryItems.get(targetId);
        let newStock = inv.stockQuantity;
        if (data.stockQuantity?.decrement !== undefined) {
          newStock -= data.stockQuantity.decrement;
        } else if (data.stockQuantity?.increment !== undefined) {
          newStock += data.stockQuantity.increment;
        }
        const updated = { ...inv, stockQuantity: newStock };
        inventoryItems.set(targetId, updated);
        return { ...updated };
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const [id, inv] of inventoryItems.entries()) {
          if (where.id && id !== where.id) continue;
          if (where.menuItemId && inv.menuItemId !== where.menuItemId) continue;
          if (where.stockQuantity?.gte !== undefined && inv.stockQuantity < where.stockQuantity.gte) {
            continue;
          }
          let newStock = inv.stockQuantity;
          if (data.stockQuantity?.decrement !== undefined) {
            newStock -= data.stockQuantity.decrement;
          } else if (data.stockQuantity?.increment !== undefined) {
            newStock += data.stockQuantity.increment;
          }
          inventoryItems.set(id, { ...inv, stockQuantity: newStock });
          count++;
        }
        return { count };
      },
    },
    order: {
      async findUnique({ where, include }: any) {
        let order: any = null;
        if (where.id) order = orders.get(where.id);
        if (where.idempotencyKey) {
          for (const o of orders.values()) {
            if (o.idempotencyKey === where.idempotencyKey) {
              order = o;
              break;
            }
          }
        }
        if (where.paymentIntentId) {
          for (const o of orders.values()) {
            if (o.paymentIntentId === where.paymentIntentId) {
              order = o;
              break;
            }
          }
        }
        if (!order) return null;
        const res: any = { ...order };
        if (include?.items) {
          res.items = Array.from(orderItems.values()).filter((i) => i.orderId === order.id);
        }
        if (include?.statusHistory) {
          res.statusHistory = Array.from(orderStatusHistory.values()).filter((h) => h.orderId === order.id);
        }
        return res;
      },
      async create({ data, include }: any) {
        // Enforce DB unique constraint on idempotencyKey
        if (data.idempotencyKey) {
          for (const o of orders.values()) {
            if (o.idempotencyKey === data.idempotencyKey) {
              const err: any = new Error('Unique constraint failed on the fields: (`idempotencyKey`)');
              err.code = 'P2002';
              throw err;
            }
          }
        }
        const id = data.id || `order-${Date.now()}-${Math.random()}`;
        const order = {
          id,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        orders.set(id, order);

        if (data.items?.create) {
          for (const itemData of data.items.create) {
            const itemId = `order-item-${Date.now()}-${Math.random()}`;
            orderItems.set(itemId, { id: itemId, orderId: id, ...itemData });
          }
        }

        const res: any = { ...order };
        if (include?.items) {
          res.items = Array.from(orderItems.values()).filter((i) => i.orderId === id);
        }
        return res;
      },
      async update({ where, data, include }: any) {
        const order = orders.get(where.id);
        if (!order) throw new Error(`Order ${where.id} not found`);
        const updated = { ...order, ...data, updatedAt: new Date() };
        orders.set(where.id, updated);
        const res: any = { ...updated };
        if (include?.items) {
          res.items = Array.from(orderItems.values()).filter((i) => i.orderId === where.id);
        }
        return res;
      },
    },
    orderStatusHistory: {
      async create({ data }: any) {
        const id = `hist-${Date.now()}-${Math.random()}`;
        const entry = { id, ...data, createdAt: new Date() };
        orderStatusHistory.set(id, entry);
        return entry;
      },
    },
    inboundWebhookEvent: {
      async findUnique({ where }: any) {
        return inboundEvents.get(where.eventId) || null;
      },
      async create({ data }: any) {
        const entry = { id: `evt-${Date.now()}`, ...data, processedAt: new Date() };
        inboundEvents.set(data.eventId, entry);
        return entry;
      },
    },
    refundAudit: {
      async create({ data }: any) {
        const id = `rfnd-${Date.now()}-${Math.random()}`;
        const entry = { id, ...data, createdAt: new Date() };
        refundAudits.set(id, entry);
        return entry;
      },
    },
    reservation: {
      async findUnique({ where }: any) {
        return reservations.get(where.id) || null;
      },
      async create({ data }: any) {
        const id = data.id || `res-${Date.now()}`;
        const r = { id, ...data, createdAt: new Date() };
        reservations.set(id, r);
        return { ...r };
      },
      async update({ where, data }: any) {
        const r = reservations.get(where.id);
        if (!r) throw new Error('Reservation not found');
        const updated = { ...r, ...data };
        reservations.set(where.id, updated);
        return { ...updated };
      },
    },
    user: {
      async findUnique({ where }: any) {
        return users.get(where.id) || null;
      },
      async create({ data }: any) {
        const id = data.id || `user-${Date.now()}-${Math.random()}`;
        const user = { id, ...data };
        users.set(id, user);
        return user;
      },
    },
    async $transaction(fn: any) {
      await acquireLock();
      try {
        return await fn(client);
      } finally {
        releaseLock();
      }
    },
    $disconnect: async () => {},
  };

  return client;
}

describe('STEP 9 ADVERSARIAL BREAK TESTS: The 4 Critical Code Review Fixes', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let menuService: MenuService;
  let ordersService: OrdersService;
  let paymentsService: PaymentsService;
  let burgerId: string;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    menuService = new MenuService(mockPrisma);
    ordersService = new OrdersService(mockPrisma, menuService);
    const testRazorpay = {
      orders: {
        create: async (options: any) => ({
          id: `order_test_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          amount: options.amount,
          currency: options.currency,
        }),
      },
    };
    paymentsService = new PaymentsService(mockPrisma, testRazorpay);

    app = await buildApp({ prismaClient: mockPrisma, razorpayClient: testRazorpay });
    await app.ready();

    // Setup: 5 Artisan Burgers in inventory
    const cat = await mockPrisma.category.create({
      data: { name: 'Gourmet Mains', slug: 'gourmet-mains' },
    });

    const item = await mockPrisma.menuItem.create({
      data: {
        categoryId: cat.id,
        name: 'Truffle Brioche Burger',
        slug: 'truffle-brioche-burger',
        description: 'Truffle aioli with butter brioche',
        basePriceInPaise: 45000, // ₹450.00
        isPerishable: true,
      },
    });
    burgerId = item.id;

    await mockPrisma.inventoryItem.create({
      data: {
        menuItemId: item.id,
        stockQuantity: 5, // Exactly 5 left in stock
      },
    });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ----------------------------------------------------
  // FIX A: INVENTORY CONCURRENCY (ZERO NEGATIVE STOCK)
  // ----------------------------------------------------
  describe('Fix A: Inventory Concurrency & Conditional Atomic Decrement', () => {
    it('MUST PREVENT overselling when two customers compete for 4 burgers with only 5 in stock', async () => {
      // Customer A wants 4 burgers. Customer B wants 4 burgers. Total requested: 8. Available: 5.
      // Under broken read-check-write, stock would drop to -3.
      // Under atomic conditional update, exactly 1 succeeds, 1 fails, and final stock is 1 (5 - 4).

      const orderAttemptA = ordersService.checkout({
        idempotencyKey: 'concurrent-burger-a',
        items: [{ menuItemId: burgerId, quantity: 4 }],
      });

      const orderAttemptB = ordersService.checkout({
        idempotencyKey: 'concurrent-burger-b',
        items: [{ menuItemId: burgerId, quantity: 4 }],
      });

      const results = await Promise.allSettled([orderAttemptA, orderAttemptB]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Verify rejection error code
      const rejectionReason: any = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectionReason.code).toBe('INSUFFICIENT_STOCK');

      // Verify database inventory: 5 - 4 = 1, NEVER NEGATIVE!
      const inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: burgerId } });
      expect(inv.stockQuantity).toBe(1);
    });
  });

  // ----------------------------------------------------
  // FIX B: GUEST ORDER AUTHORIZATION (ANTI-IDOR)
  // ----------------------------------------------------
  describe('Fix B: Guest Order Access Control & Anti-IDOR Token Protection', () => {
    it('MUST BLOCK unauthorized strangers from viewing or modifying a guest order', async () => {
      // 1. Guest customer checks out
      const checkoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        payload: {
          idempotencyKey: 'guest-idor-order-1',
          customerEmail: 'guest.victim@example.com',
          customerPhone: '+919876543210',
          items: [{ menuItemId: burgerId, quantity: 1 }],
        },
      });

      expect(checkoutRes.statusCode).toBe(201);
      const checkoutData = checkoutRes.json();
      const orderId = checkoutData.order.id;
      const validGuestToken = checkoutData.guestAccessToken;

      expect(validGuestToken).toBeDefined();
      expect(validGuestToken.startsWith('gst_')).toBe(true);

      // 2. Attacker attempts to view guest order without token -> 403 Forbidden
      const unauthorizedView = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/${orderId}`,
      });
      expect(unauthorizedView.statusCode).toBe(403);
      expect(unauthorizedView.json().code).toBe('FORBIDDEN_ORDER_ACCESS');

      // 3. Attacker attempts to view with forged token -> 403 Forbidden
      const forgedTokenView = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/${orderId}`,
        headers: { 'x-guest-access-token': 'gst_fake_token_12345' },
      });
      expect(forgedTokenView.statusCode).toBe(403);

      // 4. Legitimate guest views with valid token -> 200 OK
      const legitimateView = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/${orderId}`,
        headers: { 'x-guest-access-token': validGuestToken },
      });
      expect(legitimateView.statusCode).toBe(200);
      expect(legitimateView.json().order.id).toBe(orderId);

      // 5. Attacker attempts to cancel guest order without token -> 403 Forbidden
      const unauthorizedCancel = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${orderId}/status`,
        payload: { status: 'CANCELLED', reason: 'Malicious cancellation' },
      });
      expect(unauthorizedCancel.statusCode).toBe(403);

      // 6. Legitimate guest cancels order with valid token -> 200 OK
      const legitimateCancel = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${orderId}/status`,
        headers: { 'x-guest-access-token': validGuestToken },
        payload: { status: 'CANCELLED', reason: 'Legitimate guest cancelled' },
      });
      expect(legitimateCancel.statusCode).toBe(200);
      expect(legitimateCancel.json().order.status).toBe(OrderStatus.CANCELLED);
    });
  });

  // ----------------------------------------------------
  // FIX C: IDEMPOTENCY CONCURRENCY & PAYLOAD INTEGRITY
  // ----------------------------------------------------
  describe('Fix C: Idempotency P2002 Race Handling & Payload Integrity', () => {
    it('MUST survive 5 simultaneous checkout requests with the same key without a single 500 error', async () => {
      // 5 concurrent requests with identical key
      const requests = Array.from({ length: 5 }).map(() =>
        app.inject({
          method: 'POST',
          url: '/api/v1/orders/checkout',
          payload: {
            idempotencyKey: 'simultaneous-double-tap-key',
            customerEmail: 'fast.clicker@example.com',
            items: [{ menuItemId: burgerId, quantity: 1 }],
          },
        })
      );

      const responses = await Promise.all(requests);

      // All 5 must succeed with 200 or 201 (NONE should return 500!)
      for (const res of responses) {
        expect([200, 201]).toContain(res.statusCode);
      }

      // Exactly 1 order created in DB
      const inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: burgerId } });
      expect(inv.stockQuantity).toBe(4); // Only deducted once!
    });

    it('MUST REJECT idempotency key reuse when cart items/payload differs (Payload Fingerprint)', async () => {
      // Request 1: Order 1 Burger
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        payload: {
          idempotencyKey: 'idemp-fingerprint-test-1',
          items: [{ menuItemId: burgerId, quantity: 1 }],
        },
      });
      expect(res1.statusCode).toBe(201);

      // Request 2: Reuse same key but order 2 Burgers -> MUST REJECT with 422
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        payload: {
          idempotencyKey: 'idemp-fingerprint-test-1',
          items: [{ menuItemId: burgerId, quantity: 2 }],
        },
      });

      expect([409, 422]).toContain(res2.statusCode);
      expect(res2.json().code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    });

    it('MUST REJECT idempotency key reuse across different registered customer accounts', async () => {
      const userA = await mockPrisma.user.create({
        data: { email: 'user.a@cafe.com', role: Role.CUSTOMER },
      });
      const userB = await mockPrisma.user.create({
        data: { email: 'user.b@cafe.com', role: Role.CUSTOMER },
      });

      // User A orders with key
      await ordersService.checkout(
        {
          idempotencyKey: 'shared-cross-account-key',
          items: [{ menuItemId: burgerId, quantity: 1 }],
        },
        userA.id
      );

      // User B tries to submit checkout with User A's idempotency key
      await expect(
        ordersService.checkout(
          {
            idempotencyKey: 'shared-cross-account-key',
            items: [{ menuItemId: burgerId, quantity: 1 }],
          },
          userB.id
        )
      ).rejects.toThrow('Idempotency key belongs to another customer account');
    });
  });

  // ----------------------------------------------------
  // FIX D: PAYMENT INTENT GUEST AUTHORIZATION & REFUND
  // ----------------------------------------------------
  describe('Fix D: Payment Intent Guest Token Protection & Real Currency Standards', () => {
    it('MUST REQUIRE valid guest access token to initiate payment intent on guest order', async () => {
      const checkoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        payload: {
          idempotencyKey: 'guest-pay-intent-key',
          customerEmail: 'guest.payer@example.com',
          items: [{ menuItemId: burgerId, quantity: 1 }],
        },
      });

      const { order, guestAccessToken } = checkoutRes.json();

      // Attempt payment creation without token -> 403 Forbidden
      const resWithoutToken = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/create-intent',
        payload: { orderId: order.id },
      });
      expect(resWithoutToken.statusCode).toBe(403);
      expect(resWithoutToken.json().code).toBe('FORBIDDEN_ORDER_ACCESS');

      // Attempt payment creation with valid token -> 200 OK
      const resWithToken = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/create-intent',
        headers: { 'x-guest-access-token': guestAccessToken },
        payload: { orderId: order.id },
      });
      expect(resWithToken.statusCode).toBe(200);
      const intent = resWithToken.json().paymentIntent;
      expect(intent.currency).toBe('INR');
      expect(intent.amountInPaise).toBe(order.totalInPaise);
      expect(intent.keyId === null || typeof intent.keyId === 'string').toBe(true);
    });
  });
});
