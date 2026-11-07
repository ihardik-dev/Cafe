import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { OrderStatus, Role } from '@prisma/client';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { buildApp } from '../src/server.js';
import { PaymentsService } from '../src/modules/payments/payments.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';
import { env } from '../src/config/env.js';

function createMockPrisma() {
  const categories: Map<string, any> = new Map();
  const menuItems: Map<string, any> = new Map();
  const modifierGroups: Map<string, any> = new Map();
  const modifierOptions: Map<string, any> = new Map();
  const inventoryItems: Map<string, any> = new Map();
  const orders: Map<string, any> = new Map();
  const orderItems: Map<string, any> = new Map();
  const orderStatusHistory: Map<string, any> = new Map();
  const inboundEvents: Map<string, any> = new Map();
  const refundAudits: Map<string, any> = new Map();
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
      async update({ where, data }: any) {
        let targetId = where.id;
        if (where.menuItemId) {
          for (const inv of inventoryItems.values()) {
            if (inv.menuItemId === where.menuItemId) {
              targetId = inv.id;
              break;
            }
          }
        }
        const inv = inventoryItems.get(targetId);
        let newStock = inv.stockQuantity;
        if (data.stockQuantity?.decrement) {
          newStock -= data.stockQuantity.decrement;
        } else if (data.stockQuantity?.increment) {
          newStock += data.stockQuantity.increment;
        } else if (typeof data.stockQuantity === 'number') {
          newStock = data.stockQuantity;
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
        if (where.paymentIntentId) {
          for (const o of orders.values()) {
            if (o.paymentIntentId === where.paymentIntentId) {
              order = o;
              break;
            }
          }
        }
        if (where.idempotencyKey) {
          for (const o of orders.values()) {
            if (o.idempotencyKey === where.idempotencyKey) {
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
        return res;
      },
      async findFirst({ where, include }: any = {}) {
        for (const o of orders.values()) {
          if (where?.id && o.id !== where.id) continue;
          if (where?.paymentIntentId && o.paymentIntentId !== where.paymentIntentId) continue;
          if (where?.status && o.status !== where.status) continue;
          const res: any = { ...o };
          if (include?.items) {
            res.items = Array.from(orderItems.values()).filter((i) => i.orderId === o.id);
          }
          return res;
        }
        return null;
      },
      async findMany({ where }: any = {}) {
        let result = Array.from(orders.values());
        if (where?.status) {
          result = result.filter((o) => o.status === where.status);
        }
        return result.map((o) => ({
          ...o,
          items: Array.from(orderItems.values()).filter((i) => i.orderId === o.id),
        }));
      },
      async create({ data, include }: any) {
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
        const updated = {
          ...order,
          ...data,
          updatedAt: new Date(),
        };
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
        if (inboundEvents.has(data.eventId)) {
          const err: any = new Error('Unique constraint failed on eventId');
          err.code = 'P2002';
          throw err;
        }
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
      async findMany({ where }: any = {}) {
        return Array.from(refundAudits.values()).filter((r) => {
          if (where?.orderId && r.orderId !== where.orderId) return false;
          return true;
        });
      },
    },
    user: {
      async findUnique({ where }: any) {
        return users.get(where.id) || null;
      },
      async create({ data }: any) {
        const id = data.id || `user-${Date.now()}`;
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

function generateRazorpayCheckoutSignature(
  orderId: string,
  paymentId: string,
  secret: string = env.RAZORPAY_KEY_SECRET
): string {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

function generateWebhookSignature(
  payloadString: string,
  secret: string = env.WEBHOOK_SECRET
): string {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

describe('STEP 8 ADVERSARIAL BREAK TESTS: Razorpay Test Mode & Cryptographic Integrity', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let paymentsService: PaymentsService;
  let menuService: MenuService;
  let ordersService: OrdersService;
  let espressoId: string;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    paymentsService = new PaymentsService(mockPrisma);
    menuService = new MenuService(mockPrisma);
    ordersService = new OrdersService(mockPrisma, menuService);

    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();

    // Seed test menu item with inventory
    const cat = await mockPrisma.category.create({
      data: { name: 'Hot Coffee', slug: 'hot-coffee' },
    });

    const item = await mockPrisma.menuItem.create({
      data: {
        categoryId: cat.id,
        name: 'Single Origin Espresso',
        slug: 'single-origin-espresso',
        description: 'Rich crema espresso shot',
        basePriceInPaise: 18000, // ₹180.00
      },
    });
    espressoId = item.id;

    await mockPrisma.inventoryItem.create({
      data: {
        menuItemId: item.id,
        stockQuantity: 50,
        lowStockThreshold: 5,
      },
    });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ----------------------------------------------------
  // 1. LIVE RAZORPAY TEST API CREDENTIAL VERIFICATION
  // ----------------------------------------------------
  describe('Live Razorpay Test Credential Authentication', () => {
    it.skipIf(
      process.env.RUN_LIVE_RAZORPAY_TESTS !== '1' ||
        !env.RAZORPAY_KEY_ID ||
        !env.RAZORPAY_KEY_SECRET
    )(
      'MUST successfully authenticate against live Razorpay Test servers using provided keys',
      async () => {
        const liveRazorpay = new (Razorpay as any)({
          key_id: env.RAZORPAY_KEY_ID,
          key_secret: env.RAZORPAY_KEY_SECRET,
        });

        // Attempt to create a 1-rupee test order on Razorpay
        const rzpOrder = await liveRazorpay.orders.create({
          amount: 100, // ₹1.00 = 100 paise
          currency: 'INR',
          receipt: `test_rcpt_${Date.now()}`,
          notes: { testSuite: 'adversarial_break_test' },
        });

        expect(rzpOrder.id).toBeDefined();
        expect(rzpOrder.id.startsWith('order_')).toBe(true);
        expect(rzpOrder.status).toBe('created');
        expect(rzpOrder.currency).toBe('INR');
        expect(rzpOrder.amount).toBe(100);
      }
    );
  });

  // ----------------------------------------------------
  // 2. ADVERSARIAL SIGNATURE TAMPERING ON /verify
  // ----------------------------------------------------
  describe('Adversarial Checkout Signature Tampering & Forgery Defense', () => {
    it('MUST REJECT checkout verification when a single hex character of signature is flipped', async () => {
      const { order } = await ordersService.checkout({
        idempotencyKey: 'rzp-sig-tamper-test',
        items: [{ menuItemId: espressoId, quantity: 1 }],
      });

      const rzpOrderId = 'order_TxIjFake123456';
      const rzpPaymentId = 'pay_TxIjFake999888';
      const validSig = generateRazorpayCheckoutSignature(rzpOrderId, rzpPaymentId);

      // Tamper: Flip the last character
      const lastChar = validSig.slice(-1);
      const flippedChar = lastChar === 'a' ? 'b' : 'a';
      const tamperedSig = validSig.slice(0, -1) + flippedChar;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: rzpPaymentId,
          razorpaySignature: tamperedSig,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_PAYMENT_SIGNATURE');

      // Ensure order remains PENDING_PAYMENT
      const unchanged = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(unchanged.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('MUST REJECT verification when payment ID is swapped with another transaction', async () => {
      const { order } = await ordersService.checkout({
        idempotencyKey: 'rzp-swap-id-test',
        items: [{ menuItemId: espressoId, quantity: 1 }],
      });

      const rzpOrderId = 'order_TxIjOrder_A';
      const paymentIdForOrderB = 'pay_Stolen_From_Order_B';
      const signatureForOrderA = generateRazorpayCheckoutSignature(rzpOrderId, 'pay_Original_A');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: paymentIdForOrderB, // Swapped!
          razorpaySignature: signatureForOrderA,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_PAYMENT_SIGNATURE');
    });

    it('MUST ACCEPT valid signature and transition order to CONFIRMED', async () => {
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'rzp-legit-verify-test',
        items: [{ menuItemId: espressoId, quantity: 1 }],
      });

      const rzpOrderId = 'order_Legit_112233';
      const rzpPaymentId = 'pay_Legit_445566';
      const validSig = generateRazorpayCheckoutSignature(rzpOrderId, rzpPaymentId);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: rzpPaymentId,
          razorpaySignature: validSig,
          guestAccessToken,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.verified).toBe(true);
      expect(body.status).toBe(OrderStatus.CONFIRMED);
      expect(body.paymentId).toBe(rzpPaymentId);

      // Verify DB status
      const confirmedOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(confirmedOrder.status).toBe(OrderStatus.CONFIRMED);
    });
  });

  // ----------------------------------------------------
  // 3. CONCURRENT / RACE CONDITION VERIFY CALLS
  // ----------------------------------------------------
  describe('High-Concurrency Duplicate Verify Defense (Idempotency)', () => {
    it('MUST handle 5 concurrent verify requests idempotently without state corruption', async () => {
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'rzp-concurrent-verify',
        items: [{ menuItemId: espressoId, quantity: 2 }],
      });

      const rzpOrderId = 'order_Concurrent_1';
      const rzpPaymentId = 'pay_Concurrent_1';
      const validSig = generateRazorpayCheckoutSignature(rzpOrderId, rzpPaymentId);

      // Fire 5 identical verification requests concurrently
      const requests = Array.from({ length: 5 }).map(() =>
        app.inject({
          method: 'POST',
          url: '/api/v1/payments/verify',
          headers: { 'content-type': 'application/json' },
          payload: {
            orderId: order.id,
            razorpayOrderId: rzpOrderId,
            razorpayPaymentId: rzpPaymentId,
            razorpaySignature: validSig,
            guestAccessToken,
          },
        })
      );

      const responses = await Promise.all(requests);

      // All 5 must succeed with 200 OK
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        expect(res.json().verified).toBe(true);
      }

      // Order must be CONFIRMED exactly once
      const finalOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(finalOrder.status).toBe(OrderStatus.CONFIRMED);
    });
  });

  // ----------------------------------------------------
  // 4. LATE CHECKOUT VERIFICATION AUTO-REFUND
  // ----------------------------------------------------
  describe('Late Checkout Verification Auto-Refund Engine', () => {
    it('MUST AUTOMATICALLY trigger refund and set REFUNDED_LATE_WEBHOOK if order was cancelled before OTP', async () => {
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'rzp-late-checkout-test',
        items: [{ menuItemId: espressoId, quantity: 1 }],
      });

      // Simulate order timeout/cancellation by cleanup worker
      await mockPrisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED },
      });

      const rzpOrderId = 'order_Late_778899';
      const rzpPaymentId = 'pay_Late_123456';
      const validSig = generateRazorpayCheckoutSignature(rzpOrderId, rzpPaymentId);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: rzpPaymentId,
          razorpaySignature: validSig,
          guestAccessToken,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.refunded).toBe(true);
      expect(body.status).toBe(OrderStatus.REFUNDED_LATE_WEBHOOK);
      expect(body.gatewayRefundId).toBeDefined();

      // Ensure DB audit record exists
      const audits = await mockPrisma.refundAudit.findMany({ where: { orderId: order.id } });
      expect(audits.length).toBe(1);
      expect(audits[0].reason).toContain('LATE_CHECKOUT_VERIFICATION_AFTER_EXPIRATION');
      expect(audits[0].amountInPaise).toBe(order.totalInPaise);
    });
  });

  // ----------------------------------------------------
  // 5. NATIVE RAZORPAY WEBHOOK WITH x-razorpay-signature
  // ----------------------------------------------------
  describe('Native Razorpay Webhook Processing', () => {
    it('MUST accept native Razorpay webhook payload format with x-razorpay-signature header', async () => {
      const { order } = await ordersService.checkout({
        idempotencyKey: 'rzp-native-webhook-test',
        items: [{ menuItemId: espressoId, quantity: 1 }],
      });

      const rzpPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test_cafe',
        event: 'payment.captured',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_native_rzp_99',
              order_id: 'order_native_rzp_99',
              amount: order.totalInPaise,
              currency: 'INR',
              status: 'captured',
              notes: {
                orderId: order.id,
              },
            },
          },
        },
      });

      const validSig = generateWebhookSignature(rzpPayload);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/webhook',
        headers: {
          'x-razorpay-signature': validSig,
          'content-type': 'application/json',
        },
        payload: rzpPayload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().action).toBe('ORDER_CONFIRMED');

      const confirmed = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(confirmed.status).toBe(OrderStatus.CONFIRMED);
    });
  });
});
