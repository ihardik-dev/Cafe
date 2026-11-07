import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Role, OrderStatus } from '@prisma/client';
import crypto from 'crypto';
import { buildApp } from '../src/server.js';
import { PaymentsService } from '../src/modules/payments/payments.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';
import { CleanupWorker } from '../src/jobs/cleanup.worker.js';
import { env } from '../src/config/env.js';

function createInMemoryPrisma() {
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
      const next = queue.shift()!;
      next();
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
        if (!inv) throw new Error('Inventory not found');
        let newStock = inv.stockQuantity;
        if (data.stockQuantity?.decrement !== undefined) {
          newStock -= data.stockQuantity.decrement;
        } else if (data.stockQuantity?.increment !== undefined) {
          newStock += data.stockQuantity.increment;
        } else if (typeof data.stockQuantity === 'number') {
          newStock = data.stockQuantity;
        }
        const updated = { ...inv, stockQuantity: newStock };
        inventoryItems.set(targetId, updated);
        return { ...updated };
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
        if (where?.expiresAt?.lte) {
          const threshold = new Date(where.expiresAt.lte).getTime();
          result = result.filter((o) => new Date(o.expiresAt).getTime() <= threshold);
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
            const oItem = { id: itemId, orderId: id, ...itemData };
            orderItems.set(itemId, oItem);
          }
        }

        const res: any = { ...order };
        if (include?.items) {
          res.items = Array.from(orderItems.values()).filter((i) => i.orderId === id);
        }
        return res;
      },
      async update({ where, data }: any) {
        const order = orders.get(where.id);
        if (!order) throw new Error('Order not found');
        const updated = { ...order, ...data, updatedAt: new Date() };
        orders.set(where.id, updated);
        return { ...updated };
      },
    },
    orderStatusHistory: {
      async create({ data }: any) {
        const id = `hist-${Date.now()}-${Math.random()}`;
        const h = { id, ...data, createdAt: new Date() };
        orderStatusHistory.set(id, h);
        return { ...h };
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
        const id = `evt-${Date.now()}-${Math.random()}`;
        const ev = { id, ...data, processedAt: new Date() };
        inboundEvents.set(data.eventId, ev);
        return { ...ev };
      },
    },
    refundAudit: {
      async create({ data }: any) {
        const id = `rfnd-${Date.now()}-${Math.random()}`;
        const r = { id, ...data, createdAt: new Date() };
        refundAudits.set(id, r);
        return { ...r };
      },
      async findMany({ where }: any = {}) {
        let list = Array.from(refundAudits.values());
        if (where?.orderId) {
          list = list.filter((r) => r.orderId === where.orderId);
        }
        return list;
      },
    },
    reservationHold: {
      async deleteMany({ where }: any = {}) {
        let count = 0;
        const threshold = where.expiresAt?.lte ? new Date(where.expiresAt.lte).getTime() : Infinity;
        for (const [id, h] of holds.entries()) {
          if (new Date(h.expiresAt).getTime() <= threshold) {
            holds.delete(id);
            count++;
          }
        }
        return { count };
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

function generateSignature(payloadString: string, secret: string = env.WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

describe('STEP 6 ADVERSARIAL BREAK TESTS: Payments, Late Webhooks & Background Cleanup', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let paymentsService: PaymentsService;
  let menuService: MenuService;
  let ordersService: OrdersService;
  let cleanupWorker: CleanupWorker;

  let croissantId: string;

  beforeEach(async () => {
    mockPrisma = createInMemoryPrisma();
    paymentsService = new PaymentsService(mockPrisma);
    menuService = new MenuService(mockPrisma);
    ordersService = new OrdersService(mockPrisma, menuService);
    cleanupWorker = new CleanupWorker(mockPrisma, menuService);
    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();

    // Seed Almond Croissant with finite inventory of 5 (₹220 = 22,000 paise)
    const croissant = await mockPrisma.menuItem.create({
      data: {
        name: 'Almond Croissant',
        priceInPaise: 22000,
        isAvailable: true,
        isPerishable: true,
      },
    });
    croissantId = croissant.id;

    await mockPrisma.inventoryItem.create({
      data: {
        menuItemId: croissantId,
        stockQuantity: 5,
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Adversarial Cryptographic HMAC Webhook Security', () => {
    it('MUST REJECT webhooks with forged or missing signatures with 401 Unauthorized', async () => {
      const payload = JSON.stringify({
        eventId: 'evt_forged_123',
        eventType: 'payment.captured',
        data: {
          orderId: 'any-order-id',
          paymentIntentId: 'pi_fake',
          amountInPaise: 24000,
          currency: 'INR',
        },
      });

      // 1. Missing signature header
      const resMissing = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/webhook',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(resMissing.statusCode).toBe(401);
      expect(resMissing.json().code).toBe('INVALID_WEBHOOK_SIGNATURE');

      // 2. Forged signature signed with wrong secret key
      const forgedSignature = generateSignature(payload, 'wrong-bogus-secret-key-123456');
      const resForged = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/webhook',
        headers: {
          'x-webhook-signature': forgedSignature,
          'content-type': 'application/json',
        },
        payload,
      });
      expect(resForged.statusCode).toBe(401);
      expect(resForged.json().code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('MUST ACCEPT validly signed HMAC-SHA256 webhook payloads', async () => {
      // 1. Create an order
      const { order } = await ordersService.checkout({
        idempotencyKey: 'webhook-valid-test-1',
        items: [{ menuItemId: croissantId, quantity: 1 }],
      });
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);

      const payload = JSON.stringify({
        eventId: 'evt_legit_payment_999',
        eventType: 'payment.captured',
        data: {
          orderId: order.id,
          paymentIntentId: 'pi_legit_123',
          amountInPaise: order.totalInPaise,
          currency: 'INR',
        },
      });

      const validSignature = generateSignature(payload);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/webhook',
        headers: {
          'x-webhook-signature': validSignature,
          'content-type': 'application/json',
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().action).toBe('ORDER_CONFIRMED');

      // Verify order is now CONFIRMED
      const updated = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(updated.status).toBe(OrderStatus.CONFIRMED);
    });
  });

  describe('Adversarial Webhook Idempotency (Duplicate Delivery Flood)', () => {
    it('MUST PREVENT duplicate execution when the same webhook is delivered multiple times concurrently', async () => {
      const { order } = await ordersService.checkout({
        idempotencyKey: 'idemp-webhook-order-1',
        items: [{ menuItemId: croissantId, quantity: 1 }],
      });

      const payload = JSON.stringify({
        eventId: 'evt_concurrent_flood_888',
        eventType: 'payment.captured',
        data: {
          orderId: order.id,
          paymentIntentId: 'pi_flood_test',
          amountInPaise: order.totalInPaise,
          currency: 'INR',
        },
      });

      const signature = generateSignature(payload);

      // Fire 5 identical webhooks simultaneously
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({
            method: 'POST',
            url: '/api/v1/payments/webhook',
            headers: {
              'x-webhook-signature': signature,
              'content-type': 'application/json',
            },
            payload,
          })
        )
      );

      // All 5 must succeed with HTTP 200 (gateway receives ACK)
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
      }

      // Exactly 1 executed; the other 4 were marked duplicate
      const executed = responses.filter((r) => r.json().isDuplicate === false);
      const duplicates = responses.filter((r) => r.json().isDuplicate === true);

      expect(executed.length).toBe(1);
      expect(duplicates.length).toBe(4);
    });
  });

  describe('Adversarial Late Webhook Scenario: Automatic Refund on Expired Order', () => {
    it('MUST AUTOMATICALLY issue a refund when payment webhook arrives late for an expired/cancelled order', async () => {
      // 1. Customer initiates order for 2 Croissants (stock drops from 5 to 3)
      const { order } = await ordersService.checkout({
        idempotencyKey: 'late-webhook-victim-order',
        items: [{ menuItemId: croissantId, quantity: 2 }],
      });

      let inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(3);

      // 2. Payment window times out: order expires and is swept by background worker
      // Simulate expiration:
      await mockPrisma.order.update({
        where: { id: order.id },
        data: { expiresAt: new Date(Date.now() - 60000) }, // Expired 1 min ago
      });

      // Cleanup worker runs: cancels order and restores the 2 Croissants back to inventory (3 -> 5)
      const sweepResult = await cleanupWorker.sweepExpiredOrders();
      expect(sweepResult.cancelledCount).toBe(1);

      inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(5); // Stock restored!

      // 3. Another customer buys those 2 Croissants (stock drops back to 3)
      await ordersService.checkout({
        idempotencyKey: 'lucky-other-customer',
        items: [{ menuItemId: croissantId, quantity: 2 }],
      });
      inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(3);

      // 4. THE CRITICAL EDGE CASE: 45 minutes later, delayed bank webhook arrives saying payment succeeded!
      const lateWebhookPayload = JSON.stringify({
        eventId: 'evt_late_arrival_45mins_after',
        eventType: 'payment.captured',
        data: {
          orderId: order.id,
          paymentIntentId: 'pi_late_customer_123',
          amountInPaise: order.totalInPaise,
          currency: 'INR',
        },
      });

      const signature = generateSignature(lateWebhookPayload);

      const lateResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/webhook',
        headers: {
          'x-webhook-signature': signature,
          'content-type': 'application/json',
        },
        payload: lateWebhookPayload,
      });

      expect(lateResponse.statusCode).toBe(200);
      const resBody = lateResponse.json();

      // CRITICAL ASSERTIONS:
      // A. Must NOT fulfill the order
      expect(resBody.action).toBe('AUTOMATIC_REFUND_ISSUED');
      expect(resBody.status).toBe(OrderStatus.REFUNDED_LATE_WEBHOOK);
      expect(resBody.refundAmountInPaise).toBe(order.totalInPaise);

      // B. Must NOT corrupt or overdraw inventory (croissant stock remains 3)
      inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(3);

      // C. Must create an immutable audit record in RefundAudit
      const audits = await mockPrisma.refundAudit.findMany({ where: { orderId: order.id } });
      expect(audits.length).toBe(1);
      expect(audits[0].reason).toBe('LATE_WEBHOOK_RECEIVED_AFTER_EXPIRATION');
      expect(audits[0].amountInPaise).toBe(order.totalInPaise);
      expect(audits[0].status).toBe('SUCCEEDED');

      // D. Verify order status in DB
      const dbOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder.status).toBe(OrderStatus.REFUNDED_LATE_WEBHOOK);
    });
  });

  describe('Adversarial Payment Intent Expiration Defense', () => {
    it('MUST REJECT creating a payment intent for an expired order with 410 ORDER_EXPIRED', async () => {
      const { order } = await ordersService.checkout({
        idempotencyKey: 'expired-intent-test',
        items: [{ menuItemId: croissantId, quantity: 1 }],
      });

      // Force order expiration
      await mockPrisma.order.update({
        where: { id: order.id },
        data: { expiresAt: new Date(Date.now() - 60000) },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/create-intent',
        payload: { orderId: order.id },
      });

      expect(res.statusCode).toBe(410);
      expect(res.json().code).toBe('ORDER_EXPIRED');
    });
  });
});
