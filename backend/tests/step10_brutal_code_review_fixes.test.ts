import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { OrderStatus, Role, RefundStatus, ReservationStatus } from '@prisma/client';
import crypto from 'crypto';
import { buildApp } from '../src/server.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';
import { PaymentsService } from '../src/modules/payments/payments.service.js';
import { ReservationsService } from '../src/modules/reservations/reservations.service.js';
import { CleanupWorker } from '../src/jobs/cleanup.worker.js';
import { env } from '../src/config/env.js';

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
      async findMany({ include }: any) {
        const list = Array.from(categories.values());
        if (include?.items) {
          return list.map((cat) => ({
            ...cat,
            items: Array.from(menuItems.values())
              .filter((i) => i.categoryId === cat.id && i.isAvailable)
              .map((item) => {
                const res: any = { ...item };
                if (include.items.include?.inventory) {
                  for (const inv of inventoryItems.values()) {
                    if (inv.menuItemId === item.id) {
                      res.inventory = { ...inv };
                      break;
                    }
                  }
                }
                if (include.items.include?.modifierGroups) {
                  res.modifierGroups = [];
                }
                return res;
              }),
          }));
        }
        return list;
      },
      async findUnique({ where }: any) {
        return categories.get(where.id) || null;
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
        }
        const updated = { ...inv, stockQuantity: newStock };
        inventoryItems.set(targetId, updated);
        return { ...updated };
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const [id, inv] of inventoryItems.entries()) {
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
        const res = { ...order };
        if (include?.items) {
          res.items = Array.from(orderItems.values()).filter((i) => i.orderId === order.id);
        }
        if (include?.statusHistory) {
          res.statusHistory = Array.from(orderStatusHistory.values()).filter((h) => h.orderId === order.id);
        }
        return res;
      },
      async findMany({ where }: any) {
        let list = Array.from(orders.values());
        if (where?.status) {
          list = list.filter((o) => o.status === where.status);
        }
        if (where?.expiresAt?.lte) {
          const lteTime = new Date(where.expiresAt.lte).getTime();
          list = list.filter((o) => new Date(o.expiresAt).getTime() <= lteTime);
        }
        return list.map((o) => ({
          ...o,
          items: Array.from(orderItems.values()).filter((i) => i.orderId === o.id),
        }));
      },
      async update({ where, data }: any) {
        const ord = orders.get(where.id);
        if (!ord) throw new Error('Order not found');
        const updated = { ...ord, ...data, updatedAt: new Date() };
        orders.set(where.id, updated);
        return {
          ...updated,
          items: Array.from(orderItems.values()).filter((i) => i.orderId === where.id),
          statusHistory: Array.from(orderStatusHistory.values()).filter((h) => h.orderId === where.id),
        };
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
    },
    refundAudit: {
      async create({ data }: any) {
        const id = `rfnd-audit-${Date.now()}-${Math.random()}`;
        const audit = { id, ...data, createdAt: new Date() };
        refundAudits.set(id, audit);
        return { ...audit };
      },
      async update({ where, data }: any) {
        const a = refundAudits.get(where.id);
        if (!a) throw new Error('Refund audit not found');
        const updated = { ...a, ...data, updatedAt: new Date() };
        refundAudits.set(where.id, updated);
        return { ...updated };
      },
      async findMany({ where }: any) {
        let list = Array.from(refundAudits.values());
        if (where?.orderId) {
          list = list.filter((a) => a.orderId === where.orderId);
        }
        return list;
      },
    },
    table: {
      async create({ data }: any) {
        const id = data.id || `table-${Date.now()}`;
        const t = { id, ...data, isActive: data.isActive ?? true };
        tables.set(id, t);
        return { ...t };
      },
      async findUnique({ where }: any) {
        return tables.get(where.id) || null;
      },
      async findMany({ where }: any) {
        let list = Array.from(tables.values());
        if (where?.isActive !== undefined) {
          list = list.filter((t) => t.isActive === where.isActive);
        }
        return list;
      },
    },
    reservation: {
      async create({ data }: any) {
        const id = data.id || `res-${Date.now()}`;
        const r = { id, ...data, status: data.status || ReservationStatus.CONFIRMED, createdAt: new Date() };
        reservations.set(id, r);
        return { ...r, table: tables.get(data.tableId) };
      },
      async findUnique({ where }: any) {
        const r = reservations.get(where.id);
        if (!r) return null;
        return { ...r, table: tables.get(r.tableId) };
      },
      async findFirst({ where }: any) {
        for (const r of reservations.values()) {
          if (where.tableId && r.tableId !== where.tableId) continue;
          if (where.status && r.status !== where.status) continue;
          const s = new Date(r.startTime).getTime();
          const e = new Date(r.endTime).getTime();
          const qStart = new Date(where.endTime?.gt || 0).getTime();
          const qEnd = new Date(where.startTime?.lt || Infinity).getTime();
          if (s < qEnd && e > qStart) return { ...r };
        }
        return null;
      },
      async update({ where, data }: any) {
        const r = reservations.get(where.id);
        if (!r) throw new Error('Reservation not found');
        const updated = { ...r, ...data, updatedAt: new Date() };
        reservations.set(where.id, updated);
        return { ...updated, table: tables.get(updated.tableId) };
      },
      async findMany() {
        return Array.from(reservations.values());
      },
    },
    reservationHold: {
      async create({ data }: any) {
        const id = data.id || `hold-${Date.now()}`;
        const h = { id, ...data, createdAt: new Date() };
        holds.set(id, h);
        return { ...h };
      },
      async findUnique({ where }: any) {
        for (const h of holds.values()) {
          if (where.heldByToken && h.heldByToken === where.heldByToken) {
            return { ...h, table: tables.get(h.tableId) };
          }
          if (where.id && h.id === where.id) {
            return { ...h, table: tables.get(h.tableId) };
          }
        }
        return null;
      },
      async findFirst({ where }: any) {
        const now = Date.now();
        for (const h of holds.values()) {
          if (where.tableId && h.tableId !== where.tableId) continue;
          if (where.expiresAt?.gt && new Date(h.expiresAt).getTime() <= now) continue;
          const s = new Date(h.slotStartTime).getTime();
          const e = new Date(h.slotEndTime).getTime();
          const qStart = new Date(where.slotEndTime?.gt || 0).getTime();
          const qEnd = new Date(where.slotStartTime?.lt || Infinity).getTime();
          if (s < qEnd && e > qStart) return { ...h };
        }
        return null;
      },
      async delete({ where }: any) {
        const h = holds.get(where.id);
        if (h) holds.delete(where.id);
        return h;
      },
      async deleteMany({ where }: any = {}) {
        let count = 0;
        for (const [id, h] of Array.from(holds.entries())) {
          if (where?.id && id !== where.id) continue;
          if (where?.tableId && h.tableId !== where.tableId) continue;
          if (where?.expiresAt?.gt && new Date(h.expiresAt).getTime() <= new Date(where.expiresAt.gt).getTime()) continue;
          if (where?.expiresAt?.lte && new Date(h.expiresAt).getTime() > new Date(where.expiresAt.lte).getTime()) continue;
          holds.delete(id);
          count++;
        }
        return { count };
      },
      async findMany() {
        return Array.from(holds.values());
      },
    },
    user: {
      async findUnique({ where }: any) {
        return users.get(where.id) || null;
      },
      async create({ data }: any) {
        const id = data.id || `user-${Date.now()}`;
        const u = { id, ...data };
        users.set(id, u);
        return { ...u };
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
    async $executeRawUnsafe() {
      return 1;
    },
    async $queryRaw() {
      return [{ id: 'mock-lock' }];
    },
    $disconnect: async () => {},
  };

  return client;
}

function generateRazorpaySignature(orderId: string, paymentId: string): string {
  return crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

describe('STEP 10 ADVERSARIAL BREAK TESTS: The 7 Fresh Code Review Fixes', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let ordersService: OrdersService;
  let menuService: MenuService;
  let paymentsService: PaymentsService;
  let reservationsService: ReservationsService;
  let cleanupWorker: CleanupWorker;

  let burgerId: string;
  let tableId: string;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    menuService = new MenuService(mockPrisma);
    ordersService = new OrdersService(mockPrisma, menuService);
    paymentsService = new PaymentsService(mockPrisma);
    reservationsService = new ReservationsService(mockPrisma);
    cleanupWorker = new CleanupWorker(mockPrisma, menuService);

    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();

    // Seed Category & Burger Item
    const cat = await mockPrisma.category.create({
      data: { name: 'Gourmet Burgers', displayOrder: 1 },
    });

    const item = await mockPrisma.menuItem.create({
      data: {
        categoryId: cat.id,
        name: 'Smoked Truffle Burger',
        priceInPaise: 42000, // ₹420
        isAvailable: true,
        isPerishable: true,
      },
    });
    burgerId = item.id;

    await mockPrisma.inventoryItem.create({
      data: {
        menuItemId: item.id,
        stockQuantity: 10,
        lowStockThreshold: 3,
      },
    });

    // Seed Table
    const table = await mockPrisma.table.create({
      data: {
        tableNumber: 5,
        capacity: 4,
        area: 'INDOOR',
        isActive: true,
      },
    });
    tableId = table.id;
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // 1. PAYMENT VERIFICATION BINDING VULNERABILITY DEFENSE
  // -------------------------------------------------------------------------
  describe('Fix 1: Payment Verification Order Binding Defense', () => {
    it('MUST REJECT signature spoofing when attacker uses Order A’s valid signature with Order B’s ID', async () => {
      // Customer A checks out Order A
      const { order: orderA, guestAccessToken: guestTokenA } = await ordersService.checkout({
        idempotencyKey: 'order-a-legit-key',
        items: [{ menuItemId: burgerId, quantity: 1 }],
      });

      // Customer A generates Razorpay order & pays
      const rzpA = await paymentsService.createPaymentIntent(orderA.id, undefined, guestTokenA);
      const validPaymentIdA = 'pay_customer_A_112233';
      const validSigA = generateRazorpaySignature(rzpA.razorpayOrderId, validPaymentIdA);

      // Customer B checks out Order B
      const { order: orderB, guestAccessToken: guestTokenB } = await ordersService.checkout({
        idempotencyKey: 'order-b-attacker-key',
        items: [{ menuItemId: burgerId, quantity: 2 }],
      });
      const rzpB = await paymentsService.createPaymentIntent(orderB.id, undefined, guestTokenB);

      // ATTACK: Attacker sends Order A's valid signature alongside Order B's orderId!
      const attackRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: orderB.id,
          razorpayOrderId: rzpA.razorpayOrderId, // Order A's payment intent!
          razorpayPaymentId: validPaymentIdA,
          razorpaySignature: validSigA,
        },
      });

      // MUST REJECT with 400 Bad Request and ORDER_PAYMENT_BINDING_MISMATCH!
      expect(attackRes.statusCode).toBe(400);
      expect(attackRes.json().code).toBe('ORDER_PAYMENT_BINDING_MISMATCH');

      // Verify that Order B was NOT marked CONFIRMED!
      const checkB = await mockPrisma.order.findUnique({ where: { id: orderB.id } });
      expect(checkB.status).toBe(OrderStatus.PENDING_PAYMENT);

      // Legitimate confirmation for Order A with Order A's credentials MUST succeed
      const legitRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/verify',
        headers: { 'content-type': 'application/json' },
        payload: {
          orderId: orderA.id,
          razorpayOrderId: rzpA.razorpayOrderId,
          razorpayPaymentId: validPaymentIdA,
          razorpaySignature: validSigA,
          guestAccessToken: guestTokenA,
        },
      });

      expect(legitRes.statusCode).toBe(200);
      expect(legitRes.json().status).toBe(OrderStatus.CONFIRMED);
      expect(legitRes.json().paymentId).toBe(validPaymentIdA);
    });
  });

  // -------------------------------------------------------------------------
  // 2. DOUBLE INVENTORY RESTORATION CONCURRENCY DEFENSE
  // -------------------------------------------------------------------------
  describe('Fix 2: Double Inventory Restoration Race Defense', () => {
    it('MUST RESTORE inventory exactly once when customer cancellation races cleanup sweep', async () => {
      // Start with stock = 10
      let inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: burgerId } });
      expect(inv.stockQuantity).toBe(10);

      // Customer checks out 4 burgers -> stock becomes 6
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'race-cancel-order-key',
        items: [{ menuItemId: burgerId, quantity: 4 }],
      });

      inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: burgerId } });
      expect(inv.stockQuantity).toBe(6);

      // Simulate order expiry timestamp reached
      await mockPrisma.order.update({
        where: { id: order.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // RACE CONDITION: Fire customer cancellation AND worker sweep concurrently!
      const customerCancelPromise = ordersService.updateOrderStatus(
        order.id,
        { status: OrderStatus.CANCELLED, reason: 'Customer changed their mind' },
        { role: Role.CUSTOMER },
        guestAccessToken
      );

      const workerSweepPromise = cleanupWorker.sweepExpiredOrders();

      const results = await Promise.allSettled([customerCancelPromise, workerSweepPromise]);

      // At least one operation succeeds
      const successful = results.filter((r) => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThanOrEqual(1);

      // CRITICAL ASSERTION: Final inventory MUST be exactly 10 (6 + 4 = 10)!
      // Under broken non-conditional code, stock would have been restored twice to 14 (6 + 4 + 4)!
      const finalInv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: burgerId } });
      expect(finalInv.stockQuantity, 'Inventory stock MUST be restored exactly once, NEVER twice').toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // 3. IDEMPOTENCY OWNERSHIP PRIVACY DEFENSE
  // -------------------------------------------------------------------------
  describe('Fix 3: Idempotency Key Ownership & Cross-Session Isolation', () => {
    it('MUST PREVENT guest from accessing member order using member’s idempotency key', async () => {
      const memberUserId = 'member-user-uuid-1234';

      // 1. Authenticated member checks out
      await ordersService.checkout(
        {
          idempotencyKey: 'member-private-key-999',
          items: [{ menuItemId: burgerId, quantity: 1 }],
        },
        memberUserId
      );

      // 2. Unauthenticated guest attempts to submit the same idempotency key
      await expect(
        ordersService.checkout(
          {
            idempotencyKey: 'member-private-key-999',
            items: [{ menuItemId: burgerId, quantity: 1 }],
          },
          undefined // No user ID (guest request)
        )
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_OWNERSHIP_MISMATCH',
        statusCode: 403,
      });
    });

    it('MUST PREVENT member from claiming guest order using guest’s idempotency key', async () => {
      // 1. Guest checks out
      await ordersService.checkout({
        idempotencyKey: 'guest-public-key-777',
        items: [{ menuItemId: burgerId, quantity: 1 }],
      });

      // 2. Logged-in member attempts to reuse guest's idempotency key
      await expect(
        ordersService.checkout(
          {
            idempotencyKey: 'guest-public-key-777',
            items: [{ menuItemId: burgerId, quantity: 1 }],
          },
          'logged-in-attacker-id'
        )
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_OWNERSHIP_MISMATCH',
        statusCode: 403,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. PUBLIC MENU STOCK DATA PRIVACY DEFENSE
  // -------------------------------------------------------------------------
  describe('Fix 4: Public Menu Stock & Threshold Exposure Defense', () => {
    it('MUST NOT expose raw stockQuantity or lowStockThreshold on public GET /api/v1/menu', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/menu',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      const categories = json.menu;
      expect(categories.length).toBeGreaterThan(0);

      const items = categories[0].items;
      expect(items.length).toBeGreaterThan(0);

      const burger = items.find((i: any) => i.id === burgerId);
      expect(burger).toBeDefined();

      // MUST expose clean public boolean indicators
      expect(burger.isAvailable).toBe(true);
      expect(burger.inStock).toBe(true);

      // MUST NOT expose raw database inventory records or thresholds!
      expect(burger.inventory).toBeUndefined();
      expect(burger.stockQuantity).toBeUndefined();
      expect(burger.lowStockThreshold).toBeUndefined();
    });

    it('MUST NOT expose raw inventory counts on public GET /api/v1/menu/items/:id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/menu/items/${burgerId}`,
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      const item = json.item;

      expect(item.inStock).toBe(true);
      expect(item.inventory).toBeUndefined();
      expect(item.stockQuantity).toBeUndefined();
      expect(item.lowStockThreshold).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 5. GUEST RESERVATION CANCELLATION DEFENSE
  // -------------------------------------------------------------------------
  describe('Fix 5: Guest Reservation Cancellation via x-guest-access-token', () => {
    it('MUST ALLOW unauthenticated guest to cancel reservation using x-guest-access-token', async () => {
      // 1. Hold slot (tomorrow at 18:00 IST / 12:30 UTC)
      const hold = await reservationsService.holdSlot({
        tableId,
        guestCount: 2,
        startTime: '2026-11-15T12:30:00.000Z',
        durationMinutes: 60,
        customerName: 'Guest Diner',
        customerEmail: 'guest.diner@example.in',
        customerPhone: '+919876543210',
      });

      // 2. Confirm as unauthenticated guest
      const confirmed = await reservationsService.confirmReservation(
        { holdToken: hold.holdToken },
        {
          customerName: 'Guest Diner',
          customerEmail: 'guest.diner@example.in',
          customerPhone: '+919876543210',
          guestCount: 2,
        }
      );

      const reservationId = confirmed.id;
      const guestToken = confirmed.guestAccessToken;
      expect(guestToken).toBeDefined();
      expect(guestToken!.startsWith('gst_')).toBe(true);

      // 3. Attacker without guest token tries to cancel -> 403 Forbidden
      const unauthorizedCancel = await app.inject({
        method: 'PATCH',
        url: `/api/v1/reservations/${reservationId}/cancel`,
      });
      expect(unauthorizedCancel.statusCode).toBe(403);

      // 4. Legitimate guest cancels WITH x-guest-access-token without bearer auth -> 200 OK!
      const legitimateCancel = await app.inject({
        method: 'PATCH',
        url: `/api/v1/reservations/${reservationId}/cancel`,
        headers: {
          'x-guest-access-token': guestToken!,
        },
      });

      expect(legitimateCancel.statusCode).toBe(200);
      expect(legitimateCancel.json().reservation.status).toBe(ReservationStatus.CANCELLED);
    });
  });

  // -------------------------------------------------------------------------
  // 6. CAFE OPERATING HOURS (INDIAN STANDARD TIME) ENFORCEMENT
  // -------------------------------------------------------------------------
  describe('Fix 6: Cafe Operating Hours Enforcement (10:00 AM to 10:00 PM IST)', () => {
    it('MUST REJECT booking attempts outside cafe operating hours (e.g. 02:00 AM IST)', async () => {
      // 02:00 AM IST is 20:30 UTC the previous day -> outside 10:00 AM to 10:00 PM IST!
      await expect(
        reservationsService.holdSlot({
          tableId,
          guestCount: 2,
          startTime: '2026-11-15T20:30:00.000Z', // 02:00 AM IST
          durationMinutes: 60,
          customerName: 'Night Owl Guest',
          customerEmail: 'nightowl@example.in',
          customerPhone: '+919999911111',
        })
      ).rejects.toMatchObject({
        code: 'OUTSIDE_OPERATING_HOURS',
        statusCode: 400,
      });
    });

    it('MUST ACCEPT booking attempts inside cafe operating hours (e.g. 01:00 PM IST)', async () => {
      // 01:00 PM IST (13:00 IST) is 07:30 UTC -> strictly inside 10:00 AM to 10:00 PM IST
      const hold = await reservationsService.holdSlot({
        tableId,
        guestCount: 2,
        startTime: '2026-11-15T07:30:00.000Z', // 13:00 IST
        durationMinutes: 60,
        customerName: 'Lunch Diner',
        customerEmail: 'lunch@example.in',
        customerPhone: '+919999922222',
      });

      expect(hold.holdToken).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 7. REAL GATEWAY REFUND ERROR AUDITING & ZERO FAKE SUCCESS
  // -------------------------------------------------------------------------
  describe('Fix 7: Payment Gateway Refund Error Auditing & Financial Integrity', () => {
    it('MUST RECORD FAILED in RefundAudit and return 502 when gateway refund call fails', async () => {
      // 1. Create and confirm an order with a mock payment ID
      const { order } = await ordersService.checkout({
        idempotencyKey: 'refund-failure-test-key',
        items: [{ menuItemId: burgerId, quantity: 1 }],
      });

      await mockPrisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.CONFIRMED,
          paymentIntentId: 'order_test_intent_123',
          paymentId: 'pay_test_gateway_payment_456',
        },
      });

      // 2. Instantiate PaymentsService with a custom mock client where refund fails
      const failingGatewayClient = {
        payments: {
          refund: async () => {
            const error: any = new Error('Gateway timeout or card network unavailable');
            error.statusCode = 502;
            throw error;
          },
        },
      };

      const failingPaymentsService = new PaymentsService(mockPrisma, failingGatewayClient);

      // 3. Admin attempts to issue manual refund
      await expect(
        failingPaymentsService.issueManualRefund(
          order.id,
          'Customer food was cold',
          'admin-user-id'
        )
      ).rejects.toMatchObject({
        code: 'GATEWAY_REFUND_FAILED',
        statusCode: 502,
      });

      // 4. FINANCIAL AUDIT INTEGRITY: Database MUST record FAILED status, NOT SUCCEEDED!
      const audits = await mockPrisma.refundAudit.findMany({ where: { orderId: order.id } });
      expect(audits.length).toBe(1);
      expect(audits[0].status).toBe(RefundStatus.FAILED);
      expect(audits[0].reason).toContain('MANUAL_ADMIN_REFUND_FAILED');

      // 5. Order status MUST REMAIN CONFIRMED, NEVER falsely marked REFUNDED!
      const dbOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder.status).toBe(OrderStatus.CONFIRMED);
    });
  });
});
