import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { buildApp } from '../src/server.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { PaymentsService } from '../src/modules/payments/payments.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';
import { env } from '../src/config/env.js';
import { Role, OrderStatus, TableArea } from '@prisma/client';

function createBatch2MockPrisma() {
  const categories: Map<string, any> = new Map();
  const menuItems: Map<string, any> = new Map();
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
        const item = { id, ...data, isAvailable: true };
        menuItems.set(id, item);
        return { ...item };
      },
      async findUnique({ where, include }: any) {
        const item = menuItems.get(where.id);
        if (!item) return null;
        const res = { ...item };
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
        const id = data.id || `inv-${Date.now()}-${Math.random()}`;
        const inv = { id, ...data, lowStockThreshold: 2 };
        inventoryItems.set(id, inv);
        return { ...inv };
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const [id, inv] of inventoryItems.entries()) {
          if (where.menuItemId && inv.menuItemId !== where.menuItemId) continue;
          if (where.stockQuantity?.gte !== undefined && inv.stockQuantity < where.stockQuantity.gte) continue;
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
      async create({ data }: any) {
        const id = data.id || `order-${Date.now()}-${Math.random()}`;
        const ord = { id, ...data, createdAt: new Date() };
        orders.set(id, ord);
        if (data.items?.create) {
          for (const itm of data.items.create) {
            const itemId = `oitem-${Date.now()}-${Math.random()}`;
            orderItems.set(itemId, { id: itemId, orderId: id, ...itm });
          }
        }
        return { ...ord };
      },
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
        if (where.idempotencyScope_idempotencyKey) {
          const { idempotencyScope, idempotencyKey } = where.idempotencyScope_idempotencyKey;
          for (const o of orders.values()) {
            if (o.idempotencyScope === idempotencyScope && o.idempotencyKey === idempotencyKey) {
              order = o;
              break;
            }
          }
        } else if (where.idempotencyKey) {
          for (const o of orders.values()) {
            if (o.idempotencyKey === where.idempotencyKey) {
              order = o;
              break;
            }
          }
        }
        if (!order) return null;
        const res = { ...order };
        if (include?.items) {
          res.items = Array.from(orderItems.values()).filter((i) => i.orderId === order.id);
        }
        if (include?.statusHistory) {
          res.statusHistory = Array.from(orderStatusHistory.values()).filter((h) => h.orderId === order.id);
        }
        return res;
      },
      async update({ where, data }: any) {
        const ord = orders.get(where.id);
        if (!ord) throw new Error('Order not found');
        const updated = { ...ord, ...data, updatedAt: new Date() };
        orders.set(where.id, updated);
        return { ...updated };
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const [id, ord] of orders.entries()) {
          if (where.id && id !== where.id) continue;
          if (where.status && ord.status !== where.status) continue;
          const updated = { ...ord, ...data, updatedAt: new Date() };
          orders.set(id, updated);
          count++;
        }
        return { count };
      },
    },
    orderStatusHistory: {
      async create({ data }: any) {
        const id = `hist-${Date.now()}-${Math.random()}`;
        const h = { id, ...data, createdAt: new Date() };
        orderStatusHistory.set(id, h);
        return { ...h };
      },
      async findMany({ where }: any = {}) {
        let list = Array.from(orderStatusHistory.values());
        if (where?.orderId) {
          list = list.filter((h) => h.orderId === where.orderId);
        }
        return list;
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
      async create({ data }: any) {
        const id = data.id || `user-${Date.now()}-${Math.random()}`;
        const u = { id, ...data };
        users.set(id, u);
        return { ...u };
      },
      async findUnique({ where }: any) {
        return users.get(where.id) || null;
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

function generateSignature(orderId: string, paymentId: string): string {
  const body = `${orderId}|${paymentId}`;
  return crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
}

function generateWebhookHmac(rawBody: string): string {
  const secret = env.WEBHOOK_SECRET || env.RAZORPAY_KEY_SECRET;
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('STEP 12: BATCH 2 CODE REVIEW VERIFICATION — Payment Gateway, Signatures & Race Defense', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let ordersService: OrdersService;
  let paymentsService: PaymentsService;
  let menuService: MenuService;
  let burgerItem: any;
  let customMockRazorpay: any;

  beforeEach(async () => {
    mockPrisma = createBatch2MockPrisma();
    menuService = new MenuService(mockPrisma);
    ordersService = new OrdersService(mockPrisma, menuService);

    customMockRazorpay = {
      orders: {
        create: async (opts: any) => ({
          id: `order_rzp_${crypto.randomBytes(6).toString('hex')}`,
          amount: opts.amount,
          currency: opts.currency,
        }),
      },
      payments: {
        fetch: async (paymentId: string) => ({
          id: paymentId,
          order_id: null as any,
          amount: null as any,
          currency: 'INR',
          status: 'captured',
        }),
        refund: async () => ({
          id: `rfnd_${crypto.randomBytes(6).toString('hex')}`,
          status: 'processed',
        }),
      },
    };

    paymentsService = new PaymentsService(mockPrisma, customMockRazorpay);
    app = await buildApp({ prismaClient: mockPrisma, razorpayClient: customMockRazorpay });
    await app.ready();

    // Seed Menu Item (Burger = ₹350.00 / 35000 paise)
    const category = await mockPrisma.category.create({
      data: { name: 'Mains', displayOrder: 1 },
    });
    burgerItem = await mockPrisma.menuItem.create({
      data: {
        name: 'Gourmet Burger',
        priceInPaise: 35000,
        categoryId: category.id,
      },
    });
    await mockPrisma.inventoryItem.create({
      data: {
        menuItemId: burgerItem.id,
        stockQuantity: 50,
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // 1. SIGNATURE BINDING & MISMATCH EXPLOIT DEFENSE
  // =========================================================================

  describe('1. Payment Verification Signature & Order Binding Defense', () => {
    it('MUST REJECT signature spoofing when attacker uses Order A valid signature with Order B ID', async () => {
      // 1. Order A created by Customer A
      const { order: orderA, guestAccessToken: guestTokenA } = await ordersService.checkout({
        idempotencyKey: 'order-a-key-1',
        items: [{ menuItemId: burgerItem.id, quantity: 1 }],
      });
      const intentA = await paymentsService.createPaymentIntent(orderA.id, undefined, guestTokenA);
      const validPaymentIdA = 'pay_legit_A_12345';
      const validSignatureA = generateSignature(intentA.razorpayOrderId, validPaymentIdA);

      // 2. Order B created by Customer B
      const { order: orderB, guestAccessToken: guestTokenB } = await ordersService.checkout({
        idempotencyKey: 'order-b-key-2',
        items: [{ menuItemId: burgerItem.id, quantity: 2 }],
      });
      const intentB = await paymentsService.createPaymentIntent(orderB.id, undefined, guestTokenB);

      // 3. ATTACK: Submit Order A's valid signature with Order B's ID!
      const attackRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: orderB.id,
          razorpayOrderId: intentA.razorpayOrderId,
          razorpayPaymentId: validPaymentIdA,
          razorpaySignature: validSignatureA,
        },
      });

      expect(attackRes.statusCode).toBe(400);
      expect(attackRes.json().code).toBe('ORDER_PAYMENT_BINDING_MISMATCH');

      // Order B MUST NOT be confirmed
      const dbOrderB = await mockPrisma.order.findUnique({ where: { id: orderB.id } });
      expect(dbOrderB.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('MUST REJECT verification if an attacker tries to confirm an order without initiating payment intent', async () => {
      // Order created but createPaymentIntent was NEVER called (paymentIntentId is null)
      const { order } = await ordersService.checkout({
        idempotencyKey: 'order-no-intent-key',
        items: [{ menuItemId: burgerItem.id, quantity: 1 }],
      });

      // Attacker tries to confirm Order with an unassociated Razorpay order ID that belongs to another order
      const existingOrder = await mockPrisma.order.create({
        data: {
          orderNumber: 'ORD-OTHER-1',
          subtotalInPaise: 35000,
          taxInPaise: 1750,
          totalInPaise: 36750,
          paymentIntentId: 'order_bound_to_other',
        },
      });

      const fakePaymentId = 'pay_spoofed_777';
      const fakeSig = generateSignature('order_bound_to_other', fakePaymentId);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: order.id,
          razorpayOrderId: 'order_bound_to_other',
          razorpayPaymentId: fakePaymentId,
          razorpaySignature: fakeSig,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('ORDER_PAYMENT_BINDING_MISMATCH');
    });

    it('MUST REJECT verification when payment gateway amount does not match order total in paise', async () => {
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'amount-mismatch-key',
        items: [{ menuItemId: burgerItem.id, quantity: 1 }],
      });
      const intent = await paymentsService.createPaymentIntent(order.id, undefined, guestAccessToken);

      const paymentId = 'pay_amount_tamper_100';
      const sig = generateSignature(intent.razorpayOrderId, paymentId);

      // Configure custom mock razorpay to report a tampered amount (e.g. ₹100.00 instead of ₹367.50 / 36750 paise)
      customMockRazorpay.payments.fetch = async () => ({
        id: paymentId,
        order_id: intent.razorpayOrderId,
        amount: 10000, // ₹100 instead of order total ₹367.50
        currency: 'INR',
        status: 'captured',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: order.id,
          razorpayOrderId: intent.razorpayOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sig,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PAYMENT_AMOUNT_MISMATCH');

      // Order must remain unconfirmed
      const dbOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('MUST REJECT verification when payment gateway currency is not INR', async () => {
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'currency-mismatch-key',
        items: [{ menuItemId: burgerItem.id, quantity: 1 }],
      });
      const intent = await paymentsService.createPaymentIntent(order.id, undefined, guestAccessToken);

      const paymentId = 'pay_currency_tamper_usd';
      const sig = generateSignature(intent.razorpayOrderId, paymentId);

      // Gateway reports payment made in USD
      customMockRazorpay.payments.fetch = async () => ({
        id: paymentId,
        order_id: intent.razorpayOrderId,
        amount: order.totalInPaise,
        currency: 'USD',
        status: 'captured',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: order.id,
          razorpayOrderId: intent.razorpayOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sig,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PAYMENT_CURRENCY_MISMATCH');
    });
  });

  // =========================================================================
  // 2. CONCURRENCY & RACE CONDITION DEFENSE
  // =========================================================================

  describe('2. Payment Verification Concurrency & Race Condition Defense', () => {
    it('MUST handle 5 concurrent /verify requests idempotently with exactly ONE status history transition', async () => {
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'concurrency-verify-order',
        items: [{ menuItemId: burgerItem.id, quantity: 1 }],
      });
      const intent = await paymentsService.createPaymentIntent(order.id, undefined, guestAccessToken);

      const paymentId = 'pay_concurrent_blast_55';
      const sig = generateSignature(intent.razorpayOrderId, paymentId);

      customMockRazorpay.payments.fetch = async () => ({
        id: paymentId,
        order_id: intent.razorpayOrderId,
        amount: order.totalInPaise,
        currency: 'INR',
        status: 'captured',
      });

      // Fire 5 simultaneous verify requests
      const requests = Array.from({ length: 5 }).map(() =>
        app.inject({
          method: 'POST',
          url: '/api/v1/payments/verify',
          headers: { 'content-type': 'application/json' },
          payload: {
            orderId: order.id,
            razorpayOrderId: intent.razorpayOrderId,
            razorpayPaymentId: paymentId,
            razorpaySignature: sig,
          },
        })
      );

      const responses = await Promise.all(requests);

      // All 5 must succeed with 200 OK
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        expect(res.json().verified).toBe(true);
      }

      // Exactly ONE status transition recorded in orderStatusHistory
      const history = await mockPrisma.orderStatusHistory.findMany({ where: { orderId: order.id } });
      expect(history.length).toBe(1);
      expect(history[0].toStatus).toBe(OrderStatus.CONFIRMED);
    });

    it('MUST survive concurrent webhook and client callback race cleanly', async () => {
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'webhook-callback-race-order',
        items: [{ menuItemId: burgerItem.id, quantity: 1 }],
      });
      const intent = await paymentsService.createPaymentIntent(order.id, undefined, guestAccessToken);

      const paymentId = 'pay_race_wh_callback_11';
      const sig = generateSignature(intent.razorpayOrderId, paymentId);

      customMockRazorpay.payments.fetch = async () => ({
        id: paymentId,
        order_id: intent.razorpayOrderId,
        amount: order.totalInPaise,
        currency: 'INR',
        status: 'captured',
      });

      // Prepare Webhook Payload
      const webhookPayload = JSON.stringify({
        eventId: 'evt_race_webhook_99',
        eventType: 'payment.captured',
        data: {
          orderId: order.id,
          paymentIntentId: intent.razorpayOrderId,
          amountInPaise: order.totalInPaise,
          currency: 'INR',
        },
      });
      const webhookSig = generateWebhookHmac(webhookPayload);

      // Fire Webhook and /verify simultaneously
      const [whRes, verifyRes] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/payments/webhook',
          headers: {
            'x-webhook-signature': webhookSig,
            'content-type': 'application/json',
          },
          payload: webhookPayload,
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/payments/verify',
          headers: { 'content-type': 'application/json' },
          payload: {
            orderId: order.id,
            razorpayOrderId: intent.razorpayOrderId,
            razorpayPaymentId: paymentId,
            razorpaySignature: sig,
          },
        }),
      ]);

      expect(whRes.statusCode).toBe(200);
      expect(verifyRes.statusCode).toBe(200);

      const dbOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder.status).toBe(OrderStatus.CONFIRMED);

      // State machine integrity: exactly ONE transition recorded
      const history = await mockPrisma.orderStatusHistory.findMany({ where: { orderId: order.id } });
      expect(history.length).toBe(1);
    });
  });

  // =========================================================================
  // 3. WEBHOOK BINDING & FINANCIAL AUDITING
  // =========================================================================

  describe('3. Webhook Financial Binding & Currency Defense', () => {
    it('MUST REJECT webhook when payment amount does not match order total', async () => {
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'webhook-amount-tamper-key',
        items: [{ menuItemId: burgerItem.id, quantity: 1 }],
      });
      const intent = await paymentsService.createPaymentIntent(order.id, undefined, guestAccessToken);

      const payload = JSON.stringify({
        eventId: 'evt_tampered_amount_123',
        eventType: 'payment.captured',
        data: {
          orderId: order.id,
          paymentIntentId: intent.razorpayOrderId,
          amountInPaise: 5000, // ₹50.00 instead of ₹367.50
          currency: 'INR',
        },
      });
      const sig = generateWebhookHmac(payload);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/webhook',
        headers: {
          'x-webhook-signature': sig,
          'content-type': 'application/json',
        },
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PAYMENT_AMOUNT_MISMATCH');

      // Order must not be confirmed
      const dbOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('MUST REJECT unauthenticated stranger trying to initiate payment on registered member order', async () => {
      const member = await mockPrisma.user.create({
        data: { email: 'member.owner@cafe.com', role: Role.CUSTOMER },
      });
      const { order } = await ordersService.checkout(
        {
          idempotencyKey: 'member-order-key-55',
          items: [{ menuItemId: burgerItem.id, quantity: 1 }],
        },
        member.id
      );

      // Stranger tries to call create-intent on member's order without auth token
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/create-intent',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: order.id,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN_ORDER_ACCESS');
    });
  });
});
