import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Role } from '@prisma/client';
import { buildApp } from '../src/server.js';
import { MenuService } from '../src/modules/menu/menu.service.js';

// In-memory test repository simulating Prisma Menu & Inventory tables with atomic transactional semantics
function createInMemoryMenuPrisma() {
  const categories: Map<string, any> = new Map();
  const menuItems: Map<string, any> = new Map();
  const modifierGroups: Map<string, any> = new Map();
  const modifierOptions: Map<string, any> = new Map();
  const inventoryItems: Map<string, any> = new Map();
  const users: Map<string, any> = new Map();

  // Concurrency mutex simulation for inventory updates
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
      async findMany() {
        return Array.from(categories.values()).sort((a, b) => a.displayOrder - b.displayOrder);
      },
      async findUnique({ where }: any) {
        if (where.id) return categories.get(where.id) || null;
        if (where.name) {
          for (const c of categories.values()) {
            if (c.name === where.name) return { ...c };
          }
        }
        return null;
      },
      async create({ data }: any) {
        const id = data.id || `cat-${Date.now()}-${Math.random()}`;
        const cat = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        categories.set(id, cat);
        return { ...cat };
      },
    },
    menuItem: {
      async findMany({ where }: any) {
        let items = Array.from(menuItems.values());
        if (where?.isAvailable !== undefined) {
          items = items.filter((i) => i.isAvailable === where.isAvailable);
        }
        return items;
      },
      async findUnique({ where, include }: any) {
        const item = menuItems.get(where.id);
        if (!item) return null;
        const result: any = { ...item };
        if (include?.inventory) {
          for (const inv of inventoryItems.values()) {
            if (inv.menuItemId === item.id) {
              result.inventory = { ...inv };
              break;
            }
          }
        }
        if (include?.modifierGroups) {
          const groups: any[] = [];
          for (const g of modifierGroups.values()) {
            if (g.menuItemId === item.id) {
              const grp = { ...g, options: [] as any[] };
              for (const opt of modifierOptions.values()) {
                if (opt.groupId === g.id) {
                  grp.options.push({ ...opt });
                }
              }
              groups.push(grp);
            }
          }
          result.modifierGroups = groups;
        }
        return result;
      },
      async create({ data }: any) {
        const id = data.id || `item-${Date.now()}-${Math.random()}`;
        const item = { id, ...data, isAvailable: data.isAvailable ?? true, createdAt: new Date(), updatedAt: new Date() };
        menuItems.set(id, item);
        return { ...item };
      },
      async update({ where, data }: any) {
        const item = menuItems.get(where.id);
        if (!item) throw new Error('Menu item not found');
        const updated = { ...item, ...data, updatedAt: new Date() };
        menuItems.set(where.id, updated);
        return { ...updated };
      },
    },
    modifierGroup: {
      async findUnique({ where }: any) {
        return modifierGroups.get(where.id) || null;
      },
      async create({ data }: any) {
        const id = data.id || `group-${Date.now()}-${Math.random()}`;
        const grp = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        modifierGroups.set(id, grp);
        return { ...grp };
      },
    },
    modifierOption: {
      async findUnique({ where }: any) {
        return modifierOptions.get(where.id) || null;
      },
      async create({ data }: any) {
        const id = data.id || `opt-${Date.now()}-${Math.random()}`;
        const opt = { id, ...data, isAvailable: data.isAvailable ?? true, createdAt: new Date(), updatedAt: new Date() };
        modifierOptions.set(id, opt);
        return { ...opt };
      },
    },
    inventoryItem: {
      async findUnique({ where }: any) {
        for (const inv of inventoryItems.values()) {
          if (inv.menuItemId === where.menuItemId || inv.id === where.id) {
            return { ...inv };
          }
        }
        return null;
      },
      async upsert({ where, update, create }: any) {
        let existing: any = null;
        for (const inv of inventoryItems.values()) {
          if (inv.menuItemId === where.menuItemId) {
            existing = inv;
            break;
          }
        }
        if (existing) {
          const updated = { ...existing, ...update, updatedAt: new Date() };
          inventoryItems.set(existing.id, updated);
          return { ...updated };
        }
        const id = `inv-${Date.now()}-${Math.random()}`;
        const created = { id, ...create, lowStockThreshold: 5, updatedAt: new Date() };
        inventoryItems.set(id, created);
        return { ...created };
      },
      async create({ data }: any) {
        const id = data.id || `inv-${Date.now()}-${Math.random()}`;
        const inv = { id, ...data, lowStockThreshold: 5, updatedAt: new Date() };
        inventoryItems.set(id, inv);
        return { ...inv };
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
        if (!inv) throw new Error('Inventory record not found');
        let newStock = inv.stockQuantity;
        if (data.stockQuantity?.decrement !== undefined) {
          newStock -= data.stockQuantity.decrement;
        } else if (data.stockQuantity?.increment !== undefined) {
          newStock += data.stockQuantity.increment;
        } else if (typeof data.stockQuantity === 'number') {
          newStock = data.stockQuantity;
        }
        const updated = { ...inv, stockQuantity: newStock, updatedAt: new Date() };
        inventoryItems.set(targetId, updated);
        return { ...updated };
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
    $disconnect: async () => {},
  };

  return client;
}

describe('STEP 3 ADVERSARIAL BREAK TESTS: Menu, Modifiers & Atomic Inventory', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let menuService: MenuService;

  let coffeeCatId: string;
  let bakeryCatId: string;
  let flatWhiteId: string;
  let oatMilkOptId: string;
  let almondMilkOptId: string;
  let decafOptId: string;
  let croissantId: string;

  beforeEach(async () => {
    mockPrisma = createInMemoryMenuPrisma();
    menuService = new MenuService(mockPrisma);
    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();

    // 1. Seed Categories
    const coffeeCat = await mockPrisma.category.create({
      data: { name: 'Specialty Coffee', displayOrder: 1 },
    });
    coffeeCatId = coffeeCat.id;

    const bakeryCat = await mockPrisma.category.create({
      data: { name: 'Artisan Bakery', displayOrder: 2 },
    });
    bakeryCatId = bakeryCat.id;

    // 2. Seed Flat White with Milk Choice (min: 1, max: 1) and Extra Shots (min: 0, max: 2)
    const flatWhite = await mockPrisma.menuItem.create({
      data: {
        categoryId: coffeeCatId,
        name: 'Signature Flat White',
        priceInPaise: 24000, // ₹240
        isAvailable: true,
        isPerishable: false,
      },
    });
    flatWhiteId = flatWhite.id;

    const milkGroup = await mockPrisma.modifierGroup.create({
      data: {
        menuItemId: flatWhiteId,
        name: 'Milk Choice',
        minSelection: 1,
        maxSelection: 1,
      },
    });

    const oatMilk = await mockPrisma.modifierOption.create({
      data: {
        groupId: milkGroup.id,
        name: 'Oat Milk (Barista Edition)',
        extraPriceInPaise: 6000, // +₹60
        isAvailable: true,
      },
    });
    oatMilkOptId = oatMilk.id;

    const almondMilk = await mockPrisma.modifierOption.create({
      data: {
        groupId: milkGroup.id,
        name: 'Almond Milk',
        extraPriceInPaise: 5000, // +₹50
        isAvailable: true,
      },
    });
    almondMilkOptId = almondMilk.id;

    const decafOpt = await mockPrisma.modifierOption.create({
      data: {
        groupId: milkGroup.id,
        name: 'Decaf Blend (Out of Stock)',
        extraPriceInPaise: 4000,
        isAvailable: false, // Disabled modifier!
      },
    });
    decafOptId = decafOpt.id;

    // 3. Seed Perishable Almond Croissant with finite stock of 3
    const croissant = await mockPrisma.menuItem.create({
      data: {
        categoryId: bakeryCatId,
        name: 'Double-Baked Almond Croissant',
        priceInPaise: 22000, // ₹220
        isAvailable: true,
        isPerishable: true,
      },
    });
    croissantId = croissant.id;

    await mockPrisma.inventoryItem.create({
      data: {
        menuItemId: croissantId,
        stockQuantity: 3, // Exactly 3 croissants available
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Adversarial Concurrency: 10 Parallel Requests Competing for 3 Croissants', () => {
    it('MUST ATOMICALLY prevent overselling under high concurrency (3 succeed, 7 fail, final stock 0)', async () => {
      const concurrentRequests = 10;
      const orderQuantity = 1;

      // Fire 10 parallel atomic deduction promises simultaneously at the exact same millisecond
      const results = await Promise.allSettled(
        Array.from({ length: concurrentRequests }, () =>
          menuService.deductInventoryAtomic([{ menuItemId: croissantId, quantity: orderQuantity }])
        )
      );

      const successfulDeductions = results.filter((r) => r.status === 'fulfilled');
      const rejectedDeductions = results.filter((r) => r.status === 'rejected');

      // Crucial assertion: Exactly 3 requests could buy the 3 croissants
      expect(successfulDeductions.length, 'Exactly 3 deductions should succeed').toBe(3);
      expect(rejectedDeductions.length, 'Remaining 7 requests must be rejected with INSUFFICIENT_STOCK').toBe(7);

      for (const rej of rejectedDeductions) {
        if (rej.status === 'rejected') {
          expect((rej.reason as any).code).toBe('INSUFFICIENT_STOCK');
          expect((rej.reason as any).statusCode).toBe(409);
        }
      }

      // Verify that final inventory never dipped below 0 into negative numbers
      const finalInventory = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(finalInventory.stockQuantity, 'Final stock quantity must be exactly 0, never negative').toBe(0);
    });

    it('MUST restore inventory stock atomically when an order is cancelled', async () => {
      // 1. Deduct 2 croissants
      await menuService.deductInventoryAtomic([{ menuItemId: croissantId, quantity: 2 }]);
      let inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(1);

      // 2. Cancel order and restore
      await menuService.restoreInventoryAtomic([{ menuItemId: croissantId, quantity: 2 }]);
      inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(3);
    });
  });

  describe('Adversarial Modifier Selection & Pricing Attacks', () => {
    it('MUST REJECT cart item when minimum modifier selection is not met (0 selections for min: 1)', async () => {
      // Attacker orders Flat White without choosing any milk
      await expect(
        menuService.validateCartItem({
          menuItemId: flatWhiteId,
          quantity: 1,
          selectedModifierOptionIds: [], // 0 provided, min is 1
        })
      ).rejects.toMatchObject({
        code: 'MODIFIER_MIN_SELECTION_NOT_MET',
        statusCode: 400,
      });
    });

    it('MUST REJECT cart item when maximum modifier selection is exceeded (2 selections for max: 1)', async () => {
      // Attacker selects both Oat Milk and Almond Milk
      await expect(
        menuService.validateCartItem({
          menuItemId: flatWhiteId,
          quantity: 1,
          selectedModifierOptionIds: [oatMilkOptId, almondMilkOptId],
        })
      ).rejects.toMatchObject({
        code: 'MODIFIER_MAX_SELECTION_EXCEEDED',
        statusCode: 400,
      });
    });

    it('MUST REJECT foreign/orphaned modifier injection (trying to put Oat Milk on an Almond Croissant)', async () => {
      await expect(
        menuService.validateCartItem({
          menuItemId: croissantId, // Croissant has no milk modifier group
          quantity: 1,
          selectedModifierOptionIds: [oatMilkOptId],
        })
      ).rejects.toMatchObject({
        code: 'MODIFIER_DOES_NOT_BELONG_TO_ITEM',
        statusCode: 400,
      });
    });

    it('MUST REJECT unavailable/disabled modifier options', async () => {
      await expect(
        menuService.validateCartItem({
          menuItemId: flatWhiteId,
          quantity: 1,
          selectedModifierOptionIds: [decafOptId], // Decaf is marked isAvailable: false
        })
      ).rejects.toMatchObject({
        code: 'MODIFIER_UNAVAILABLE',
        statusCode: 400,
      });
    });

    it('MUST calculate pricing accurately server-side in Indian paise', async () => {
      // Flat White (₹240 = 24000 paise) + Oat Milk (+₹60 = 6000 paise) * 2 qty = ₹600 = 60000 paise
      const validated = await menuService.validateCartItem({
        menuItemId: flatWhiteId,
        quantity: 2,
        selectedModifierOptionIds: [oatMilkOptId],
      });

      expect(validated.unitPriceInPaise).toBe(30000); // 24000 + 6000
      expect(validated.totalPriceInPaise).toBe(60000); // 30000 * 2
      expect(validated.modifiers.length).toBe(1);
      expect(validated.modifiers[0]?.extraPriceInPaise).toBe(6000);
    });
  });

  describe('Adversarial Inventory & RBAC HTTP API Endpoints', () => {
    it('MUST BLOCK Customer tokens from creating items or updating stock with 403 Forbidden', async () => {
      const customerToken = app.jwt.sign({
        id: 'cust-1',
        email: 'customer@cafe.in',
        role: Role.CUSTOMER,
      });

      const attempt1 = await app.inject({
        method: 'POST',
        url: '/api/v1/menu/items',
        headers: { authorization: `Bearer ${customerToken}` },
        payload: {
          categoryId: coffeeCatId,
          name: 'Hacked Coffee',
          priceInPaise: 100,
        },
      });
      expect(attempt1.statusCode).toBe(403);

      const attempt2 = await app.inject({
        method: 'PATCH',
        url: `/api/v1/menu/inventory/${croissantId}`,
        headers: { authorization: `Bearer ${customerToken}` },
        payload: { stockQuantity: 999 },
      });
      expect(attempt2.statusCode).toBe(403);
    });

    it('MUST REJECT negative stock restock attempts with 400 Bad Request', async () => {
      const staffToken = app.jwt.sign({
        id: 'staff-1',
        email: 'staff@cafe.in',
        role: Role.STAFF,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/menu/inventory/${croissantId}`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { stockQuantity: -10 }, // Negative stock attack!
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/(cannot be negative|must be >= 0)/i);
    });

    it('MUST ALLOW Staff and Admin to update stock and toggle availability', async () => {
      const staffToken = app.jwt.sign({
        id: 'staff-1',
        email: 'staff@cafe.in',
        role: Role.STAFF,
      });

      // Staff restocks croissants to 25
      const restockRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/menu/inventory/${croissantId}`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { stockQuantity: 25 },
      });
      expect(restockRes.statusCode).toBe(200);
      expect(restockRes.json().inventory.stockQuantity).toBe(25);

      // Staff marks item temporarily unavailable
      const toggleRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/menu/items/${croissantId}/availability`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { isAvailable: false },
      });
      expect(toggleRes.statusCode).toBe(200);
      expect(toggleRes.json().item.isAvailable).toBe(false);
    });
  });
});
