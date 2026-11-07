import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { OrderStatus, Role, TableArea, ReservationStatus } from '@prisma/client';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { buildApp } from '../src/server.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';
import { ReservationsService } from '../src/modules/reservations/reservations.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { env } from '../src/config/env.js';

function createMockPrisma() {
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
      async update({ where, data }: any) {
        const item = menuItems.get(where.id);
        if (!item) throw new Error('Menu item not found');
        const updated = { ...item, ...data };
        menuItems.set(where.id, updated);
        return { ...updated };
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
      async findMany({ where }: any = {}) {
        let result = Array.from(orders.values());
        if (where?.status) {
          result = result.filter((o) => o.status === where.status);
        }
        if (where?.userId) {
          result = result.filter((o) => o.userId === where.userId);
        }
        return result.map((o) => ({
          ...o,
          items: Array.from(orderItems.values()).filter((i) => i.orderId === o.id),
        }));
      },
      async count({ where }: any = {}) {
        let result = Array.from(orders.values());
        if (where?.status) {
          result = result.filter((o) => o.status === where.status);
        }
        return result.length;
      },
      async create({ data }: any) {
        const id = data.id || `order-${Date.now()}-${Math.random()}`;
        const order = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        orders.set(id, order);

        if (data.items?.create) {
          for (const itemData of data.items.create) {
            const itemId = `order-item-${Date.now()}-${Math.random()}`;
            orderItems.set(itemId, { id: itemId, orderId: id, ...itemData });
          }
        }

        return {
          ...order,
          items: Array.from(orderItems.values()).filter((i) => i.orderId === id),
        };
      },
      async update({ where, data }: any) {
        const order = orders.get(where.id);
        if (!order) throw new Error('Order not found');
        const updated = { ...order, ...data, updatedAt: new Date() };
        orders.set(where.id, updated);
        return {
          ...updated,
          items: Array.from(orderItems.values()).filter((i) => i.orderId === where.id),
        };
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
    table: {
      async findUnique({ where }: any) {
        return tables.get(where.id) || null;
      },
      async create({ data }: any) {
        const id = data.id || `tbl-${Date.now()}`;
        const t = { id, ...data };
        tables.set(id, t);
        return { ...t };
      },
      async findMany({ where }: any = {}) {
        let result = Array.from(tables.values());
        if (where?.isActive !== undefined) {
          result = result.filter((t) => t.isActive === where.isActive);
        }
        if (where?.capacity?.gte !== undefined) {
          result = result.filter((t) => t.capacity >= where.capacity.gte);
        }
        return result;
      },
    },
    reservationHold: {
      async findUnique({ where, include }: any) {
        let hold: any = null;
        if (where.heldByToken) {
          for (const h of holds.values()) {
            if (h.heldByToken === where.heldByToken) {
              hold = h;
              break;
            }
          }
        }
        if (!hold) return null;
        const res: any = { ...hold };
        if (include?.table) {
          res.table = tables.get(hold.tableId);
        }
        return res;
      },
      async findFirst({ where }: any = {}) {
        for (const h of holds.values()) {
          if (where.tableId && h.tableId !== where.tableId) continue;
          if (where.expiresAt?.gt && new Date(h.expiresAt).getTime() <= new Date(where.expiresAt.gt).getTime()) continue;
          if (where.slotStartTime?.lt && where.slotEndTime?.gt) {
            const hStart = new Date(h.slotStartTime).getTime();
            const hEnd = new Date(h.slotEndTime).getTime();
            const slotStart = new Date(where.slotEndTime.gt).getTime();
            const slotEnd = new Date(where.slotStartTime.lt).getTime();
            if (hStart < slotEnd && hEnd > slotStart) return { ...h };
          }
        }
        return null;
      },
      async findMany({ where }: any = {}) {
        let result = Array.from(holds.values());
        if (where?.tableId?.in) {
          result = result.filter((h) => where.tableId.in.includes(h.tableId));
        }
        return result;
      },
      async create({ data }: any) {
        const id = data.id || `hold-${Date.now()}-${Math.random()}`;
        const hold = { id, ...data };
        holds.set(id, hold);
        return { ...hold };
      },
      async delete({ where }: any) {
        for (const [id, h] of holds.entries()) {
          if (h.id === where.id || h.heldByToken === where.heldByToken) {
            holds.delete(id);
            return h;
          }
        }
        return null;
      },
      async deleteMany({ where }: any = {}) {
        let count = 0;
        for (const [id, h] of holds.entries()) {
          if (where.tableId && h.tableId !== where.tableId) continue;
          if (where.expiresAt?.lte && new Date(h.expiresAt).getTime() > new Date(where.expiresAt.lte).getTime()) {
            continue;
          }
          holds.delete(id);
          count++;
        }
        return { count };
      },
    },
    reservation: {
      async findUnique({ where }: any) {
        return reservations.get(where.id) || null;
      },
      async findFirst({ where }: any = {}) {
        for (const r of reservations.values()) {
          if (where.tableId && r.tableId !== where.tableId) continue;
          if (where.status && r.status !== where.status) continue;
          if (where.startTime?.lt && where.endTime?.gt) {
            const rStart = new Date(r.startTime).getTime();
            const rEnd = new Date(r.endTime).getTime();
            const slotStart = new Date(where.endTime.gt).getTime();
            const slotEnd = new Date(where.startTime.lt).getTime();
            // Check interval overlap: rStart < slotEnd && rEnd > slotStart
            if (rStart < slotEnd && rEnd > slotStart) {
              return { ...r };
            }
          }
        }
        return null;
      },
      async findMany({ where }: any = {}) {
        let result = Array.from(reservations.values());
        if (where?.tableId?.in) {
          result = result.filter((r) => where.tableId.in.includes(r.tableId));
        }
        if (where?.status) {
          result = result.filter((r) => r.status === where.status);
        }
        return result.map((r) => ({
          ...r,
          table: tables.get(r.tableId),
        }));
      },
      async create({ data }: any) {
        const id = data.id || `res-${Date.now()}-${Math.random()}`;
        const r = { id, ...data, createdAt: new Date() };
        reservations.set(id, r);
        return { ...r, table: tables.get(r.tableId) };
      },
      async update({ where, data }: any) {
        const r = reservations.get(where.id);
        if (!r) throw new Error('Reservation not found');
        const updated = { ...r, ...data };
        reservations.set(where.id, updated);
        return { ...updated, table: tables.get(r.tableId) };
      },
    },
    user: {
      async findUnique({ where }: any) {
        for (const u of users.values()) {
          if (where.id && u.id === where.id) return { ...u };
          if (where.email && u.email === where.email) return { ...u };
        }
        return null;
      },
      async create({ data }: any) {
        const id = data.id || `user-${Date.now()}-${Math.random()}`;
        const u = { id, ...data };
        users.set(id, u);
        return { ...u };
      },
      async update({ where, data }: any) {
        const u = users.get(where.id);
        if (!u) throw new Error('User not found');
        const updated = { ...u, ...data };
        users.set(where.id, updated);
        return { ...updated };
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
    async $queryRaw() {
      return [{ 1: 1 }];
    },
    $disconnect: async () => {},
  };

  return client;
}

describe('STEP 9 MASTERCLASS ADVERSARIAL BREAK TESTS: The 8 Advanced Engineering Hardening Features', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let ordersService: OrdersService;
  let menuService: MenuService;
  let reservationsService: ReservationsService;
  let authService: AuthService;
  let tableTwoSeaterId: string;
  let almondCroissantId: string;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    menuService = new MenuService(mockPrisma);
    ordersService = new OrdersService(mockPrisma, menuService);
    reservationsService = new ReservationsService(mockPrisma);

    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();
    authService = new AuthService(mockPrisma, app);

    // 1. Create a 2-seater cafe table
    const table = await mockPrisma.table.create({
      data: { tableNumber: 12, capacity: 2, area: TableArea.INDOOR, isActive: true },
    });
    tableTwoSeaterId = table.id;

    // 2. Create menu item
    const cat = await mockPrisma.category.create({
      data: { name: 'Bakery', slug: 'bakery' },
    });
    const item = await mockPrisma.menuItem.create({
      data: {
        categoryId: cat.id,
        name: 'Almond Twice-Baked Croissant',
        slug: 'almond-croissant',
        basePriceInPaise: 26000,
        isPerishable: true,
      },
    });
    almondCroissantId = item.id;
    await mockPrisma.inventoryItem.create({
      data: { menuItemId: item.id, stockQuantity: 20 },
    });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ----------------------------------------------------
  // 1. CAPACITY TAMPERING PREVENTION (ISSUE E)
  // ----------------------------------------------------
  describe('Fix E1: Party Size Capacity Tampering Defense', () => {
    it('MUST REJECT confirmation when customer holds 2-seater table but tries to confirm for 8 guests', async () => {
      // 1. Hold table for 2 guests
      const holdRes = await reservationsService.holdSlot({
        tableId: tableTwoSeaterId,
        startTime: '2026-11-15T12:30:00.000Z', // 18:00 IST (6:00 PM IST)
        durationMinutes: 60,
        customerName: 'Sneaky Guest',
        customerEmail: 'sneaky@example.com',
        customerPhone: '+919999988888',
        guestCount: 2,
      });

      // 2. Try to confirm for 8 guests on a table of capacity 2
      await expect(
        reservationsService.confirmReservation(
          { holdToken: holdRes.holdToken },
          {
            customerName: 'Sneaky Guest',
            customerEmail: 'sneaky@example.com',
            customerPhone: '+919999988888',
            guestCount: 8, // Exceeds table.capacity = 2!
          }
        )
      ).rejects.toThrow('Cannot confirm reservation for 8 guests. Table 12 maximum capacity is 2.');
    });
  });

  // ----------------------------------------------------
  // 2. RESERVATION INTERVAL OVERLAP DEFENSE (ISSUE E)
  // ----------------------------------------------------
  describe('Fix E2: Multi-Interval Reservation Overlap Defense', () => {
    it('MUST REJECT overlapping reservation when an intersecting slot is already confirmed', async () => {
      const now = new Date();
      const slotAStart = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow 10:00
      const slotAEnd = new Date(slotAStart.getTime() + 90 * 60 * 1000);   // Tomorrow 11:30

      // Reservation A confirmed from 10:00 to 11:30
      await mockPrisma.reservation.create({
        data: {
          tableId: tableTwoSeaterId,
          customerName: 'Confirmed Guest',
          customerEmail: 'confirmed@example.com',
          customerPhone: '+919111122222',
          guestCount: 2,
          startTime: slotAStart,
          endTime: slotAEnd,
          status: ReservationStatus.CONFIRMED,
        },
      });

      // Hold B created for intersecting slot: 11:00 to 12:00
      const slotBStart = new Date(slotAStart.getTime() + 60 * 60 * 1000); // 11:00
      const slotBEnd = new Date(slotBStart.getTime() + 60 * 60 * 1000);   // 12:00
      const holdB = await mockPrisma.reservationHold.create({
        data: {
          tableId: tableTwoSeaterId,
          slotStartTime: slotBStart,
          slotEndTime: slotBEnd,
          heldByToken: 'hold_token_intersecting',
          guestCount: 2,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      // Attempt confirmation of Hold B -> MUST REJECT with 409 conflict
      await expect(
        reservationsService.confirmReservation(
          { holdToken: holdB.heldByToken },
          {
            customerName: 'Late Guest',
            customerEmail: 'late@example.com',
            customerPhone: '+919333344444',
            guestCount: 2,
          }
        )
      ).rejects.toThrow('Slot has already been confirmed by another reservation.');
    });
  });

  // ----------------------------------------------------
  // 3. STAFF REFUND PRIVILEGE ESCALATION (ISSUE F)
  // ----------------------------------------------------
  describe('Fix F: Order Status Transition RBAC Hardening (Refunds are ADMIN ONLY)', () => {
    it('MUST BLOCK staff members from bypassing manual refund endpoint to mark order REFUNDED', async () => {
      const { order } = await ordersService.checkout({
        idempotencyKey: 'staff-refund-exploit-key',
        items: [{ menuItemId: almondCroissantId, quantity: 1 }],
      });

      // Simulate order confirmed by payment
      await mockPrisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CONFIRMED },
      });

      // Staff member tries to transition order directly to REFUNDED
      await expect(
        ordersService.updateOrderStatus(
          order.id,
          { status: OrderStatus.REFUNDED, reason: 'Staff tried manual refund' },
          { role: Role.STAFF, id: 'staff_1' }
        )
      ).rejects.toThrow('Forbidden: Only administrators can transition an order to REFUNDED status');

      // Admin user tries to transition -> ALLOWED
      const adminUpdated = await ordersService.updateOrderStatus(
        order.id,
        { status: OrderStatus.REFUNDED, reason: 'Admin authorized refund' },
        { role: Role.ADMIN, id: 'admin_1' }
      );
      expect(adminUpdated.status).toBe(OrderStatus.REFUNDED);
    });
  });

  // ----------------------------------------------------
  // 4. JWT REFRESH SECRET SEPARATION & PASSWORD LIMIT (ISSUE G)
  // ----------------------------------------------------
  describe('Fix G: Cryptographic Separation of Access vs Refresh Secrets', () => {
    it('MUST REJECT refresh tokens signed with JWT_SECRET instead of JWT_REFRESH_SECRET', async () => {
      const user = await mockPrisma.user.create({
        data: { email: 'sec.test@cafe.com', role: Role.CUSTOMER },
      });

      // Illegitimate token: Signed with JWT_SECRET (the access token secret)
      const illegitimateToken = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Attempt refresh with access-token-secret-signed token -> MUST REJECT
      await expect(authService.refreshToken(illegitimateToken)).rejects.toThrow(
        'Invalid or expired refresh token'
      );
    });

    it('MUST REJECT registration password exceeding 72 bytes to prevent bcrypt truncation bypass', async () => {
      const passwordOver72Bytes = 'A'.repeat(75) + '1a';

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'overflow@example.com',
          name: 'Overflow User',
          password: passwordOver72Bytes,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('72-byte cryptographic length limit');
    });
  });

  // ----------------------------------------------------
  // 5. ORDER ITEM PRODUCT NAME SNAPSHOT (SECTION 3)
  // ----------------------------------------------------
  describe('Fix Section 3: OrderItem Product Name Snapshot Integrity', () => {
    it('MUST preserve historical product name on OrderItem even after menu item name changes', async () => {
      // 1. Order item: "Almond Twice-Baked Croissant"
      const { order } = await ordersService.checkout({
        idempotencyKey: 'snapshot-name-test-1',
        items: [{ menuItemId: almondCroissantId, quantity: 2 }],
      });

      const orderItem = order.items[0];
      expect(orderItem.name).toBe('Almond Twice-Baked Croissant');

      // 2. Cafe renames the menu item 6 months later
      await mockPrisma.menuItem.update({
        where: { id: almondCroissantId },
        data: { name: 'Pistachio Croissant Special' },
      });

      // 3. Historical receipt still displays original purchased name!
      const fetchedOrder = await ordersService.getOrderById(order.id, { role: Role.ADMIN });
      expect(fetchedOrder.items[0].name).toBe('Almond Twice-Baked Croissant');
    });
  });

  // ----------------------------------------------------
  // 6. READINESS VS LIVENESS HEALTH PROBES (SECTION 6)
  // ----------------------------------------------------
  describe('Fix Section 6: Liveness vs Readiness Probes', () => {
    it('MUST return UP on /health (liveness) and READY with database connectivity on /ready (readiness)', async () => {
      const liveness = await app.inject({ method: 'GET', url: '/health' });
      expect(liveness.statusCode).toBe(200);
      expect(liveness.json().status).toBe('UP');

      const readiness = await app.inject({ method: 'GET', url: '/ready' });
      expect(readiness.statusCode).toBe(200);
      expect(readiness.json().status).toBe('READY');
      expect(readiness.json().database).toBe('CONNECTED');
    });
  });

  // ----------------------------------------------------
  // 7. ADMIN / STAFF MANAGEMENT APIS (SECTION 5)
  // ----------------------------------------------------
  describe('Fix Section 5: Staff/Admin Order & Reservation Listing APIs', () => {
    it('MUST allow staff/admin to list all orders and reject unauthenticated/customer users', async () => {
      // 1. Create a customer and staff token
      const staffToken = app.jwt.sign({ id: 'staff_99', email: 'staff@cafe.com', role: Role.STAFF });
      const customerToken = app.jwt.sign({ id: 'cust_99', email: 'cust@cafe.com', role: Role.CUSTOMER });

      // Customer trying to list all orders -> 403 Forbidden
      const customerAttempt = await app.inject({
        method: 'GET',
        url: '/api/v1/orders',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(customerAttempt.statusCode).toBe(403);

      // Staff listing all orders -> 200 OK with paginated list
      const staffAttempt = await app.inject({
        method: 'GET',
        url: '/api/v1/orders',
        headers: { authorization: `Bearer ${staffToken}` },
      });
      expect(staffAttempt.statusCode).toBe(200);
      expect(staffAttempt.json().orders).toBeDefined();
    });

    it('MUST allow staff/admin to view all reservations schedule and reject customer users', async () => {
      const staffToken = app.jwt.sign({ id: 'staff_99', email: 'staff@cafe.com', role: Role.STAFF });
      const customerToken = app.jwt.sign({ id: 'cust_99', email: 'cust@cafe.com', role: Role.CUSTOMER });

      // Customer trying to list schedule -> 403 Forbidden
      const customerAttempt = await app.inject({
        method: 'GET',
        url: '/api/v1/reservations',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(customerAttempt.statusCode).toBe(403);

      // Staff listing schedule -> 200 OK
      const staffAttempt = await app.inject({
        method: 'GET',
        url: '/api/v1/reservations',
        headers: { authorization: `Bearer ${staffToken}` },
      });
      expect(staffAttempt.statusCode).toBe(200);
      expect(staffAttempt.json().reservations).toBeDefined();
    });
  });
});
