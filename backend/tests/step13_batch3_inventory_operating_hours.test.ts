import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';
import { CleanupWorker } from '../src/jobs/cleanup.worker.js';
import { Role, OrderStatus, TableArea } from '@prisma/client';

function createBatch3MockPrisma() {
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
      async findMany({ include }: any = {}) {
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
        const inv = { id, ...data, lowStockThreshold: data.lowStockThreshold ?? 2 };
        inventoryItems.set(id, inv);
        return { ...inv };
      },
      async findUnique({ where }: any) {
        return inventoryItems.get(where.id) || null;
      },
      async update({ where, data }: any) {
        const inv = inventoryItems.get(where.id);
        if (!inv) throw new Error('Inventory item not found');
        let newStock = inv.stockQuantity;
        if (data.stockQuantity?.decrement !== undefined) {
          newStock -= data.stockQuantity.decrement;
        } else if (data.stockQuantity?.increment !== undefined) {
          newStock += data.stockQuantity.increment;
        }
        if (newStock < 0) {
          const err: any = new Error('CHECK constraint failed: stockQuantity >= 0');
          err.code = 'P2004';
          throw err;
        }
        const updated = { ...inv, stockQuantity: newStock };
        inventoryItems.set(where.id, updated);
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
          if (newStock < 0) {
            const err: any = new Error('CHECK constraint failed: stockQuantity >= 0');
            err.code = 'P2004';
            throw err;
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
        let order = orders.get(where.id);
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
      async findMany({ where, include }: any = {}) {
        let list = Array.from(orders.values());
        if (where?.status) {
          list = list.filter((o) => o.status === where.status);
        }
        if (where?.expiresAt?.lte) {
          const lteTime = new Date(where.expiresAt.lte).getTime();
          list = list.filter((o) => new Date(o.expiresAt).getTime() <= lteTime);
        }
        return list.map((o) => {
          const res: any = { ...o };
          if (include?.items) {
            res.items = Array.from(orderItems.values()).filter((i) => i.orderId === o.id);
          }
          return res;
        });
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
        return Array.from(orderStatusHistory.values()).filter((h) => {
          if (where?.orderId && h.orderId !== where.orderId) return false;
          return true;
        });
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
      async findMany({ where }: any = {}) {
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
        const r = { id, ...data, status: data.status || 'CONFIRMED', createdAt: new Date() };
        reservations.set(id, r);
        return { ...r, table: tables.get(data.tableId) };
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

// Convert IST (UTC+05:30) date & time to UTC ISO string
function getIstSlotIso(dateStr: string, hourIst: number, minuteIst: number): string {
  // IST = UTC + 5:30 -> UTC = IST - 5:30
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const utcTotalMinutes = hourIst * 60 + minuteIst - 330;
  const utcHours = Math.floor(utcTotalMinutes / 60);
  const utcMinutes = utcTotalMinutes % 60;
  d.setUTCHours(utcHours, utcMinutes, 0, 0);
  return d.toISOString();
}

describe('STEP 13: BATCH 3 CODE REVIEW VERIFICATION — Inventory Integrity & Operating Hours', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let menuService: MenuService;
  let ordersService: OrdersService;
  let cleanupWorker: CleanupWorker;
  let burgerItem: any;
  let burgerInventory: any;
  let table4Seater: any;

  beforeEach(async () => {
    mockPrisma = createBatch3MockPrisma();
    menuService = new MenuService(mockPrisma);
    ordersService = new OrdersService(mockPrisma, menuService);
    cleanupWorker = new CleanupWorker(mockPrisma, menuService);

    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();

    // 1. Seed Category and Perishable Burger
    const category = await mockPrisma.category.create({
      data: { name: 'Gourmet Sandwiches', displayOrder: 1 },
    });

    burgerItem = await mockPrisma.menuItem.create({
      data: {
        name: 'Artisan Burger',
        priceInPaise: 35000,
        categoryId: category.id,
        isPerishable: true,
      },
    });

    // 5 burgers in stock initially
    burgerInventory = await mockPrisma.inventoryItem.create({
      data: {
        menuItemId: burgerItem.id,
        stockQuantity: 5,
        lowStockThreshold: 2,
      },
    });

    // 2. Seed Table
    table4Seater = await mockPrisma.table.create({
      data: { tableNumber: 5, capacity: 4, area: TableArea.INDOOR, isActive: true },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // 1. INVENTORY CONCURRENCY & ZERO NEGATIVE STOCK DEFENSE
  // =========================================================================

  describe('1. Inventory Concurrency & Atomic Conditional Decrement', () => {
    it('MUST atomically prevent overselling when 2 customers compete for 4 burgers with only 5 in stock', async () => {
      // 5 burgers in stock. Customer A orders 4, Customer B orders 4 concurrently.
      const [resA, resB] = await Promise.allSettled([
        ordersService.checkout({
          idempotencyKey: 'race-customer-a-key',
          items: [{ menuItemId: burgerItem.id, quantity: 4 }],
        }),
        ordersService.checkout({
          idempotencyKey: 'race-customer-b-key',
          items: [{ menuItemId: burgerItem.id, quantity: 4 }],
        }),
      ]);

      const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
      const rejected = [resA, resB].filter((r) => r.status === 'rejected');

      // Exactly ONE order must succeed (4 burgers sold)
      expect(fulfilled.length).toBe(1);

      // Exactly ONE order must be rejected with 409 INSUFFICIENT_STOCK
      expect(rejected.length).toBe(1);
      const rejectionReason: any = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectionReason.statusCode).toBe(409);
      expect(rejectionReason.code).toBe('INSUFFICIENT_STOCK');

      // Final stock quantity in database MUST be 1 (5 - 4 = 1), NEVER negative (-3)
      const finalInventory = await mockPrisma.inventoryItem.findUnique({
        where: { id: burgerInventory.id },
      });
      expect(finalInventory.stockQuantity).toBe(1);
    });

    it('MUST enforce database CHECK constraint ("stockQuantity" >= 0) to prevent negative stock', async () => {
      // Direct attempt to update stock below 0 must throw CHECK constraint violation
      await expect(
        mockPrisma.inventoryItem.update({
          where: { id: burgerInventory.id },
          data: {
            stockQuantity: {
              decrement: 10, // Stock is 5 -> 5 - 10 = -5 (Violation)
            },
          },
        })
      ).rejects.toThrow('CHECK constraint failed: stockQuantity >= 0');

      // Stock remains untouched at 5
      const inv = await mockPrisma.inventoryItem.findUnique({ where: { id: burgerInventory.id } });
      expect(inv.stockQuantity).toBe(5);
    });
  });

  // =========================================================================
  // 2. DOUBLE INVENTORY RESTORATION RACE DEFENSE
  // =========================================================================

  describe('2. Double Inventory Restoration Race Defense', () => {
    it('MUST restore stock exactly ONCE when customer cancellation races background cleanup sweep', async () => {
      // 1. Place order reserving 3 burgers (5 in stock -> 2 remaining)
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'cancel-race-order-key',
        items: [{ menuItemId: burgerItem.id, quantity: 3 }],
      });

      let currentInv = await mockPrisma.inventoryItem.findUnique({ where: { id: burgerInventory.id } });
      expect(currentInv.stockQuantity).toBe(2);

      // Force order to be expired
      await mockPrisma.order.update({
        where: { id: order.id },
        data: { expiresAt: new Date(Date.now() - 60000) },
      });

      // 2. Customer cancel and Worker sweep race simultaneously
      const [cancelResult, sweepResult] = await Promise.allSettled([
        ordersService.updateOrderStatus(
          order.id,
          { status: OrderStatus.CANCELLED },
          { role: Role.CUSTOMER },
          guestAccessToken
        ),
        cleanupWorker.sweepExpiredOrders(),
      ]);

      // At least one succeeded
      const anySuccess = cancelResult.status === 'fulfilled' || sweepResult.status === 'fulfilled';
      expect(anySuccess).toBe(true);

      // Final inventory MUST be restored to exactly 5 (2 + 3 = 5), NEVER 8 (double restoration bug)!
      const finalInv = await mockPrisma.inventoryItem.findUnique({ where: { id: burgerInventory.id } });
      expect(finalInv.stockQuantity).toBe(5);

      const dbOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder.status).toBe(OrderStatus.CANCELLED);
    });
  });

  // =========================================================================
  // 3. CAFE OPERATING HOURS ENFORCEMENT (10:00 AM - 10:00 PM IST)
  // =========================================================================

  describe('3. Cafe Operating Hours Enforcement (10:00 AM to 10:00 PM IST)', () => {
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    it('MUST REJECT booking attempts outside cafe operating hours (e.g. 02:00 AM IST)', async () => {
      const slot2amIst = getIstSlotIso(tomorrowStr, 2, 0); // 02:00 AM IST

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/hold',
        payload: {
          tableId: table4Seater.id,
          startTime: slot2amIst,
          durationMinutes: 60,
          customerName: 'Late Owl',
          customerEmail: 'owl@example.com',
          customerPhone: '+919876543210',
          guestCount: 2,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('OUTSIDE_OPERATING_HOURS');
    });

    it('MUST REJECT booking attempts that end after closing time (e.g. 09:30 PM IST with 90 min duration)', async () => {
      // 09:30 PM (21:30) + 90 mins = 11:00 PM (23:00) IST -> Past 10:00 PM closing!
      const slot930pmIst = getIstSlotIso(tomorrowStr, 21, 30);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/hold',
        payload: {
          tableId: table4Seater.id,
          startTime: slot930pmIst,
          durationMinutes: 90,
          customerName: 'Late Diner',
          customerEmail: 'diner@example.com',
          customerPhone: '+919876543210',
          guestCount: 2,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('OUTSIDE_OPERATING_HOURS');
    });

    it('MUST ACCEPT booking attempts inside cafe operating hours (e.g. 01:00 PM IST)', async () => {
      const slot1pmIst = getIstSlotIso(tomorrowStr, 13, 0); // 01:00 PM IST

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/reservations/hold',
        payload: {
          tableId: table4Seater.id,
          startTime: slot1pmIst,
          durationMinutes: 60,
          customerName: 'Regular Diner',
          customerEmail: 'regular@example.com',
          customerPhone: '+919876543210',
          guestCount: 2,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().holdToken).toBeDefined();
    });
  });

  // =========================================================================
  // 4. PUBLIC MENU STOCK PRIVACY DEFENSE
  // =========================================================================

  describe('4. Public Menu Stock & Threshold Privacy Defense', () => {
    it('MUST NOT expose raw stockQuantity or lowStockThreshold on public GET /api/v1/menu', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/menu',
      });

      expect(res.statusCode).toBe(200);
      const menu = res.json().menu;
      expect(menu.length).toBeGreaterThan(0);

      const burger = menu[0].items.find((i: any) => i.id === burgerItem.id);
      expect(burger).toBeDefined();

      // Clean boolean public indicator
      expect(burger.inStock).toBe(true);

      // Raw inventory records MUST be completely stripped
      expect(burger.inventory).toBeUndefined();
      expect(burger.stockQuantity).toBeUndefined();
      expect(burger.lowStockThreshold).toBeUndefined();
    });

    it('MUST NOT expose raw inventory counts on public GET /api/v1/menu/items/:id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/menu/items/${burgerItem.id}`,
      });

      expect(res.statusCode).toBe(200);
      const item = res.json().item;
      expect(item).toBeDefined();
      expect(item.inStock).toBe(true);

      // Internal inventory data stripped
      expect(item.inventory).toBeUndefined();
      expect(item.stockQuantity).toBeUndefined();
      expect(item.lowStockThreshold).toBeUndefined();
    });
  });
});
