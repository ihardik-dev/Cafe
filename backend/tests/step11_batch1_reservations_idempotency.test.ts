import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';
import { ReservationsService } from '../src/modules/reservations/reservations.service.js';
import { Role, TableArea, ReservationStatus, OrderStatus, PaymentStatus } from '@prisma/client';

function createBatch1MockPrisma() {
  const categories: Map<string, any> = new Map();
  const menuItems: Map<string, any> = new Map();
  const inventoryItems: Map<string, any> = new Map();
  const orders: Map<string, any> = new Map();
  const orderItems: Map<string, any> = new Map();
  const orderStatusHistory: Map<string, any> = new Map();
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
    simulateLockFailure: false,
    rawQueryCalls: [] as string[],

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
        // Enforce scoped unique constraint: @@unique([idempotencyScope, idempotencyKey])
        if (data.idempotencyKey) {
          for (const o of orders.values()) {
            if (
              o.idempotencyScope === data.idempotencyScope &&
              o.idempotencyKey === data.idempotencyKey
            ) {
              const p2002: any = new Error(
                'Unique constraint failed on the fields: (`idempotencyScope`,`idempotencyKey`)'
              );
              p2002.code = 'P2002';
              throw p2002;
            }
          }
        }
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
    },
    orderStatusHistory: {
      async create({ data }: any) {
        const id = `hist-${Date.now()}-${Math.random()}`;
        const h = { id, ...data, createdAt: new Date() };
        orderStatusHistory.set(id, h);
        return { ...h };
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
        const id = data.id || `res-${Date.now()}-${Math.random()}`;
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
    },
    reservationHold: {
      async create({ data }: any) {
        const id = data.id || `hold-${Date.now()}-${Math.random()}`;
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
    async $queryRaw(strings: TemplateStringsArray, ...values: any[]) {
      const queryText = strings.join('?');
      client.rawQueryCalls.push(queryText);
      if (client.simulateLockFailure) {
        throw new Error('Lock acquisition failed or timed out: FOR UPDATE lock could not be obtained');
      }
      if (queryText.includes('SELECT id') && queryText.includes('"Table"') && queryText.includes('FOR UPDATE')) {
        const tableId = values[0];
        const table = tables.get(tableId);
        return table ? [{ id: table.id }] : [];
      }
      return [];
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

// Generate valid booking slot ISO string tomorrow at 14:00 IST (08:30 UTC)
function getValidBookingIso(hoursIst = 14, minutesIst = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  // IST is UTC+5:30. To set IST hours/minutes in UTC:
  // utcHours = hoursIst - 5.5
  const utcHours = hoursIst - 5;
  const utcMinutes = minutesIst - 30;
  d.setUTCHours(utcHours, utcMinutes, 0, 0);
  return d.toISOString();
}

describe('STEP 11: BATCH 1 CODE REVIEW VERIFICATION — Reservations & Idempotency', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let table4Seater: any;
  let burgerItem: any;

  beforeEach(async () => {
    mockPrisma = createBatch1MockPrisma();
    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();

    // Seed Table
    table4Seater = await mockPrisma.table.create({
      data: { tableNumber: 10, capacity: 4, area: TableArea.INDOOR, isActive: true },
    });

    // Seed Menu Category and Items
    const category = await mockPrisma.category.create({
      data: { name: 'Mains', displayOrder: 1 },
    });
    burgerItem = await mockPrisma.menuItem.create({
      data: {
        name: 'Gourmet Burger',
        price: 35000, // 350.00 INR
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
  // SECTION 1: RESERVATIONS ENGINE LOCKING & DUPLICATE HOLD TESTS
  // =========================================================================

  describe('Section 1: Reservation Locking and Hold Confirmation Security', () => {
    it('1. MUST use $queryRaw with FOR UPDATE to acquire row-level table lock during hold and confirmation', async () => {
      const slotIso = getValidBookingIso(14, 0);

      // 1. Hold a slot
      const holdRes = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/hold',
        payload: {
          tableId: table4Seater.id,
          startTime: slotIso,
          durationMinutes: 60,
          customerName: 'Aarav Sharma',
          customerEmail: 'aarav@example.com',
          customerPhone: '+919876543210',
          guestCount: 2,
        },
      });

      expect(holdRes.statusCode).toBe(201);
      const holdToken = holdRes.json().holdToken;
      expect(holdToken).toBeDefined();

      // Verify $queryRaw was called with FOR UPDATE on "Table"
      const holdLockQuery = mockPrisma.rawQueryCalls.find(
        (q: string) => q.includes('SELECT id') && q.includes('"Table"') && q.includes('FOR UPDATE')
      );
      expect(holdLockQuery).toBeDefined();

      // Clear query log to verify confirmReservation call
      mockPrisma.rawQueryCalls = [];

      // 2. Confirm the reservation
      const confirmRes = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/confirm',
        payload: {
          holdToken,
          customerName: 'Aarav Sharma',
          customerEmail: 'aarav@example.com',
          customerPhone: '+919876543210',
          guestCount: 2,
        },
      });

      expect(confirmRes.statusCode).toBe(201);
      const confirmLockQuery = mockPrisma.rawQueryCalls.find(
        (q: string) => q.includes('SELECT id') && q.includes('"Table"') && q.includes('FOR UPDATE')
      );
      expect(confirmLockQuery).toBeDefined();
    });

    it('2. MUST fail and roll back cleanly if row-level lock acquisition fails (Never swallow lock failure)', async () => {
      mockPrisma.simulateLockFailure = true;

      const slotIso = getValidBookingIso(14, 0);

      const holdRes = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/hold',
        payload: {
          tableId: table4Seater.id,
          startTime: slotIso,
          durationMinutes: 60,
          customerName: 'Aarav Sharma',
          customerEmail: 'aarav@example.com',
          customerPhone: '+919876543210',
          guestCount: 2,
        },
      });

      // Must fail with 500 error because lock acquisition failure must never be swallowed silently
      expect(holdRes.statusCode).toBe(500);

      // Verify no hold was persisted
      const holds = await mockPrisma.reservationHold.findMany();
      expect(holds.length).toBe(0);
    });

    it('3. MUST allow exactly ONE confirmation when two simultaneous confirmation requests compete for the same hold', async () => {
      const slotIso = getValidBookingIso(15, 0);

      const holdRes = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/hold',
        payload: {
          tableId: table4Seater.id,
          startTime: slotIso,
          durationMinutes: 60,
          customerName: 'Neha Patel',
          customerEmail: 'neha@example.com',
          customerPhone: '+919876543211',
          guestCount: 3,
        },
      });
      expect(holdRes.statusCode).toBe(201);
      const holdToken = holdRes.json().holdToken;

      // Two simultaneous confirmation requests with the exact same hold token
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/reservations/confirm',
          payload: {
            holdToken,
            customerName: 'Neha Patel',
            customerEmail: 'neha@example.com',
            customerPhone: '+919876543211',
            guestCount: 3,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/reservations/confirm',
          payload: {
            holdToken,
            customerName: 'Neha Patel',
            customerEmail: 'neha@example.com',
            customerPhone: '+919876543211',
            guestCount: 3,
          },
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      expect(statusCodes[0]).toBe(201);
      expect([404, 409]).toContain(statusCodes[1]);

      // Exactly 1 reservation created, hold consumed and deleted
      const allHolds = await mockPrisma.reservationHold.findMany();
      expect(allHolds.length).toBe(0);
    });

    it('4. MUST allow at most ONE success when two overlapping holds for the same table attempt confirmation', async () => {
      const slot1Start = new Date(getValidBookingIso(16, 0));
      const slot1End = new Date(getValidBookingIso(17, 30));

      const slot2Start = new Date(getValidBookingIso(17, 0)); // Overlaps! 5:00 PM - 6:00 PM
      const slot2End = new Date(getValidBookingIso(18, 0));

      // Create two holds manually in DB (simulating pre-existing overlapping holds)
      const hold1 = await mockPrisma.reservationHold.create({
        data: {
          tableId: table4Seater.id,
          slotStartTime: slot1Start,
          slotEndTime: slot1End,
          heldByToken: 'hold-token-valid-1',
          guestCount: 2,
          expiresAt: new Date(Date.now() + 600000),
        },
      });

      const hold2 = await mockPrisma.reservationHold.create({
        data: {
          tableId: table4Seater.id,
          slotStartTime: slot2Start,
          slotEndTime: slot2End,
          heldByToken: 'hold-token-valid-2',
          guestCount: 2,
          expiresAt: new Date(Date.now() + 600000),
        },
      });

      // Confirm hold1 -> Must succeed
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/confirm',
        payload: {
          holdToken: hold1.heldByToken,
          customerName: 'Customer One',
          customerEmail: 'one@example.com',
          customerPhone: '+919876543201',
          guestCount: 2,
        },
      });
      expect(res1.statusCode).toBe(201);

      // Confirm hold2 (overlapping) -> Must be rejected with 409 RESERVATION_CONFLICT
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/confirm',
        payload: {
          holdToken: hold2.heldByToken,
          customerName: 'Customer Two',
          customerEmail: 'two@example.com',
          customerPhone: '+919876543202',
          guestCount: 2,
        },
      });
      expect(res2.statusCode).toBe(409);
      expect(res2.json().code).toBe('RESERVATION_CONFLICT');
    });
  });

  // =========================================================================
  // SECTION 2: SCOPED IDEMPOTENCY TESTS
  // =========================================================================

  describe('Section 2: Scoped Idempotency and Collision Verification', () => {
    it('5. MUST return existing order with 200 when SAME user resubmits with SAME key and SAME payload', async () => {
      const user = await mockPrisma.user.create({
        data: { email: 'customer1@example.com', role: Role.CUSTOMER },
      });
      const userToken = app.jwt.sign({ id: user.id, email: user.email, role: Role.CUSTOMER });

      const payload = {
        idempotencyKey: 'idemp-key-repeat-test',
        items: [{ menuItemId: burgerItem.id, quantity: 2 }],
      };

      // First submission -> 201 Created
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: { authorization: `Bearer ${userToken}` },
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const order1 = res1.json().order;
      expect(order1).toBeDefined();

      // Duplicate submission -> 200 OK with identical order
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: { authorization: `Bearer ${userToken}` },
        payload,
      });
      expect(res2.statusCode).toBe(200);
      const order2 = res2.json().order;
      expect(order2.id).toBe(order1.id);
      expect(res2.json().isDuplicateSubmission).toBe(true);
    });

    it('6. MUST reject with 409 Conflict when SAME user resubmits with SAME key but DIFFERENT payload', async () => {
      const user = await mockPrisma.user.create({
        data: { email: 'customer2@example.com', role: Role.CUSTOMER },
      });
      const userToken = app.jwt.sign({ id: user.id, email: user.email, role: Role.CUSTOMER });

      // First submission with 1 burger
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          idempotencyKey: 'idemp-key-payload-tamper',
          items: [{ menuItemId: burgerItem.id, quantity: 1 }],
        },
      });
      expect(res1.statusCode).toBe(201);

      // Resubmission with same key but 3 burgers -> 409 Conflict
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          idempotencyKey: 'idemp-key-payload-tamper',
          items: [{ menuItemId: burgerItem.id, quantity: 3 }],
        },
      });
      expect(res2.statusCode).toBe(409);
      expect(res2.json().code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    });

    it('7. MUST allow DIFFERENT users to use the SAME idempotency key without colliding (Scoped to user)', async () => {
      const userA = await mockPrisma.user.create({
        data: { email: 'userA@example.com', role: Role.CUSTOMER },
      });
      const userB = await mockPrisma.user.create({
        data: { email: 'userB@example.com', role: Role.CUSTOMER },
      });
      const tokenA = app.jwt.sign({ id: userA.id, email: userA.email, role: Role.CUSTOMER });
      const tokenB = app.jwt.sign({ id: userB.id, email: userB.email, role: Role.CUSTOMER });

      const sharedKey = 'common-idempotency-key-100';

      // User A submits
      const resA = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          idempotencyKey: sharedKey,
          items: [{ menuItemId: burgerItem.id, quantity: 1 }],
        },
      });
      expect(resA.statusCode).toBe(201);
      const orderA = resA.json().order;

      // User B submits with the SAME key
      const resB = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          idempotencyKey: sharedKey,
          items: [{ menuItemId: burgerItem.id, quantity: 1 }],
        },
      });
      // Thanks to scoped idempotency ("user:userA" vs "user:userB"), User B is NOT blocked
      expect(resB.statusCode).toBe(201);
      const orderB = resB.json().order;

      // They MUST be separate orders
      expect(orderB.id).not.toBe(orderA.id);
      expect(orderA.userId).toBe(userA.id);
      expect(orderB.userId).toBe(userB.id);
    });

    it('8. MUST allow DIFFERENT guest sessions to use the SAME idempotency key without colliding', async () => {
      const sharedKey = 'guest-common-idempotency-key-200';

      // Guest Session 1
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: {
          'x-guest-session-id': 'guest-session-alpha',
        },
        payload: {
          idempotencyKey: sharedKey,
          customerName: 'Guest Alpha',
          customerEmail: 'alpha@example.com',
          items: [{ menuItemId: burgerItem.id, quantity: 1 }],
        },
      });
      expect(res1.statusCode).toBe(201);
      const order1 = res1.json().order;

      // Guest Session 2 with SAME key
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: {
          'x-guest-session-id': 'guest-session-beta',
        },
        payload: {
          idempotencyKey: sharedKey,
          customerName: 'Guest Beta',
          customerEmail: 'beta@example.com',
          items: [{ menuItemId: burgerItem.id, quantity: 1 }],
        },
      });
      expect(res2.statusCode).toBe(201);
      const order2 = res2.json().order;

      // Separate orders created
      expect(order2.id).not.toBe(order1.id);
      expect(res1.json().guestAccessToken).toBeDefined();
      expect(res2.json().guestAccessToken).toBeDefined();
    });

    it('9. MUST handle two SIMULTANEOUS checkout requests from different owners: neither receives the other’s order', async () => {
      const user1 = await mockPrisma.user.create({
        data: { email: 'simul1@example.com', role: Role.CUSTOMER },
      });
      const user2 = await mockPrisma.user.create({
        data: { email: 'simul2@example.com', role: Role.CUSTOMER },
      });
      const token1 = app.jwt.sign({ id: user1.id, email: user1.email, role: Role.CUSTOMER });
      const token2 = app.jwt.sign({ id: user2.id, email: user2.email, role: Role.CUSTOMER });

      const commonKey = 'simultaneous-concurrency-key-999';

      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/orders/checkout',
          headers: { authorization: `Bearer ${token1}` },
          payload: {
            idempotencyKey: commonKey,
            items: [{ menuItemId: burgerItem.id, quantity: 1 }],
          },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/orders/checkout',
          headers: { authorization: `Bearer ${token2}` },
          payload: {
            idempotencyKey: commonKey,
            items: [{ menuItemId: burgerItem.id, quantity: 1 }],
          },
        }),
      ]);

      expect(res1.statusCode).toBe(201);
      expect(res2.statusCode).toBe(201);

      const order1 = res1.json().order;
      const order2 = res2.json().order;

      expect(order1.id).not.toBe(order2.id);
      expect(order1.userId).toBe(user1.id);
      expect(order2.userId).toBe(user2.id);
    });
  });
});
