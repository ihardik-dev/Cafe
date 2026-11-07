import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Role, OrderStatus } from '@prisma/client';
import { buildApp } from '../src/server.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';

function createInMemoryPrisma() {
  const categories: Map<string, any> = new Map();
  const menuItems: Map<string, any> = new Map();
  const modifierGroups: Map<string, any> = new Map();
  const modifierOptions: Map<string, any> = new Map();
  const inventoryItems: Map<string, any> = new Map();
  const orders: Map<string, any> = new Map();
  const orderItems: Map<string, any> = new Map();
  const orderStatusHistory: Map<string, any> = new Map();
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
          res.modifierGroups = groups;
        }
        return res;
      },
    },
    modifierGroup: {
      async create({ data }: any) {
        const id = data.id || `group-${Date.now()}`;
        const g = { id, ...data };
        modifierGroups.set(id, g);
        return { ...g };
      },
    },
    modifierOption: {
      async create({ data }: any) {
        const id = data.id || `opt-${Date.now()}`;
        const opt = { id, ...data };
        modifierOptions.set(id, opt);
        return { ...opt };
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
      async findMany({ where }: any) {
        let result = Array.from(orders.values());
        if (where?.userId) {
          result = result.filter((o) => o.userId === where.userId);
        }
        return result;
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
            const oItem = {
              id: itemId,
              orderId: id,
              menuItemId: itemData.menuItemId,
              quantity: itemData.quantity,
              unitPriceInPaise: itemData.unitPriceInPaise,
              totalPriceInPaise: itemData.totalPriceInPaise,
              modifiers: itemData.modifiers?.create || [],
            };
            orderItems.set(itemId, oItem);
          }
        }

        if (data.statusHistory?.create) {
          const histId = `hist-${Date.now()}-${Math.random()}`;
          const h = { id: histId, orderId: id, ...data.statusHistory.create, createdAt: new Date() };
          orderStatusHistory.set(histId, h);
        }

        const res: any = { ...order };
        if (include?.items) {
          res.items = Array.from(orderItems.values()).filter((i) => i.orderId === id);
        }
        if (include?.statusHistory) {
          res.statusHistory = Array.from(orderStatusHistory.values()).filter((h) => h.orderId === id);
        }
        return res;
      },
      async update({ where, data, include }: any) {
        const order = orders.get(where.id);
        if (!order) throw new Error('Order not found');
        const updated = { ...order, ...data, updatedAt: new Date() };
        orders.set(where.id, updated);

        const res: any = { ...updated };
        if (include?.items) {
          res.items = Array.from(orderItems.values()).filter((i) => i.orderId === where.id);
        }
        if (include?.statusHistory) {
          res.statusHistory = Array.from(orderStatusHistory.values()).filter((h) => h.orderId === where.id);
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

describe('STEP 4 ADVERSARIAL BREAK TESTS: Order State Machine & Server-Side Pricing', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let menuService: MenuService;
  let ordersService: OrdersService;

  let flatWhiteId: string;
  let oatMilkOptId: string;
  let croissantId: string;

  beforeEach(async () => {
    mockPrisma = createInMemoryPrisma();
    menuService = new MenuService(mockPrisma);
    ordersService = new OrdersService(mockPrisma, menuService);
    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();

    // Seed Flat White (₹240 = 24000 paise) + Oat Milk (+₹60 = 6000 paise)
    const flatWhite = await mockPrisma.menuItem.create({
      data: {
        name: 'Signature Flat White',
        priceInPaise: 24000,
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
        name: 'Oat Milk',
        extraPriceInPaise: 6000,
        isAvailable: true,
      },
    });
    oatMilkOptId = oatMilk.id;

    // Seed Almond Croissant with finite inventory of 5
    const croissant = await mockPrisma.menuItem.create({
      data: {
        name: 'Almond Croissant',
        priceInPaise: 22000, // ₹220
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

  describe('Adversarial State Machine Transitions', () => {
    it('MUST BLOCK illegal state jump from PENDING_PAYMENT directly to COMPLETED (skipping payment!)', async () => {
      // 1. Create order
      const { order } = await ordersService.checkout({
        idempotencyKey: 'state-attack-order-1',
        items: [{ menuItemId: flatWhiteId, quantity: 1, selectedModifierOptionIds: [oatMilkOptId] }],
      });
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);

      // 2. Attacker attempts jumping directly to COMPLETED
      await expect(
        ordersService.updateOrderStatus(
          order.id,
          { status: OrderStatus.COMPLETED, reason: 'Trying to skip payment' },
          { role: Role.ADMIN }
        )
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 422,
      });
    });

    it('MUST BLOCK resurrecting a CANCELLED order to READY_FOR_PICKUP or COMPLETED', async () => {
      const { order } = await ordersService.checkout({
        idempotencyKey: 'state-attack-order-2',
        items: [{ menuItemId: flatWhiteId, quantity: 1, selectedModifierOptionIds: [oatMilkOptId] }],
      });

      // Legitimate cancellation
      await ordersService.updateOrderStatus(
        order.id,
        { status: OrderStatus.CANCELLED },
        { role: Role.ADMIN }
      );

      // Illegal resurrection attempt
      await expect(
        ordersService.updateOrderStatus(
          order.id,
          { status: OrderStatus.READY_FOR_PICKUP },
          { role: Role.ADMIN }
        )
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 422,
      });
    });

    it('MUST ALLOW valid linear order progression: PENDING_PAYMENT -> CONFIRMED -> PREPARING -> READY_FOR_PICKUP -> COMPLETED', async () => {
      const { order } = await ordersService.checkout({
        idempotencyKey: 'valid-flow-order',
        items: [{ menuItemId: flatWhiteId, quantity: 1, selectedModifierOptionIds: [oatMilkOptId] }],
      });

      // 1. Payment confirmed
      let updated = await ordersService.updateOrderStatus(
        order.id,
        { status: OrderStatus.CONFIRMED },
        { role: Role.ADMIN }
      );
      expect(updated.status).toBe(OrderStatus.CONFIRMED);

      // 2. Kitchen starts preparing
      updated = await ordersService.updateOrderStatus(
        order.id,
        { status: OrderStatus.PREPARING },
        { role: Role.STAFF }
      );
      expect(updated.status).toBe(OrderStatus.PREPARING);

      // 3. Ready for pickup
      updated = await ordersService.updateOrderStatus(
        order.id,
        { status: OrderStatus.READY_FOR_PICKUP },
        { role: Role.STAFF }
      );
      expect(updated.status).toBe(OrderStatus.READY_FOR_PICKUP);

      // 4. Completed
      updated = await ordersService.updateOrderStatus(
        order.id,
        { status: OrderStatus.COMPLETED },
        { role: Role.STAFF }
      );
      expect(updated.status).toBe(OrderStatus.COMPLETED);

      // 5. Terminal state: Completed orders CANNOT be updated
      await expect(
        ordersService.updateOrderStatus(
          order.id,
          { status: OrderStatus.CONFIRMED },
          { role: Role.ADMIN }
        )
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 422,
      });
    });
  });

  describe('Adversarial Idempotency Key & Double-Checkout Attack', () => {
    it('MUST PREVENT double order creation when identical idempotencyKey is submitted concurrently', async () => {
      const sharedKey = 'idemp-double-checkout-test-key-999';
      const checkoutPayload = {
        idempotencyKey: sharedKey,
        items: [{ menuItemId: croissantId, quantity: 2 }],
      };

      // Initial checkout: Deducts 2 croissants (stock 5 -> 3)
      const res1 = await ordersService.checkout(checkoutPayload);
      expect(res1.isDuplicateSubmission).toBe(false);

      let inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(3);

      // Double-submission attack with SAME idempotencyKey
      const res2 = await ordersService.checkout(checkoutPayload);
      expect(res2.isDuplicateSubmission).toBe(true);
      expect(res2.order.id).toBe(res1.order.id); // Exactly the same order returned

      // Verify inventory was NOT deducted again (still 3, NOT 1!)
      inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(3);
    });
  });

  describe('Adversarial Price Spoofing & Financial Calculation (INR)', () => {
    it('MUST IGNORE client-injected prices and compute real total with 5% GST', async () => {
      // Flat White: ₹240 (24,000 paise) + Oat Milk: ₹60 (6,000 paise) = ₹300 (30,000 paise)
      // 5% GST = 30,000 * 0.05 = 1,500 paise (₹15)
      // Total = 31,500 paise (₹315)
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        payload: {
          idempotencyKey: 'price-spoof-attack-key-1',
          items: [{ menuItemId: flatWhiteId, quantity: 1, selectedModifierOptionIds: [oatMilkOptId] }],
          totalInPaise: 0, // Attacker trying to say bill is ₹0.00!
          subtotalInPaise: 0,
          taxInPaise: 0,
        },
      });

      expect(response.statusCode).toBe(201);
      const { order } = response.json();

      expect(order.subtotalInPaise).toBe(30000);
      expect(order.taxInPaise).toBe(1500); // 5% GST
      expect(order.totalInPaise).toBe(31500); // ₹315.00
    });
  });

  describe('Adversarial Stock Restoration on Order Cancellation', () => {
    it('MUST automatically restore reserved stock when order is cancelled from PENDING_PAYMENT', async () => {
      // 1. Order 3 Croissants (stock drops from 5 to 2)
      const { order, guestAccessToken } = await ordersService.checkout({
        idempotencyKey: 'cancel-restore-key-1',
        items: [{ menuItemId: croissantId, quantity: 3 }],
      });

      let inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(2);

      // 2. Customer cancels order with guest access token
      await ordersService.updateOrderStatus(
        order.id,
        { status: OrderStatus.CANCELLED, reason: 'Changed mind' },
        { role: Role.CUSTOMER },
        guestAccessToken
      );

      // 3. Stock MUST be restored back to 5
      inv = await mockPrisma.inventoryItem.findUnique({ where: { menuItemId: croissantId } });
      expect(inv.stockQuantity).toBe(5);
    });
  });

  describe('Adversarial Horizontal Privilege Escalation (Viewing Others’ Orders)', () => {
    it('MUST BLOCK Customer B from viewing Customer A’s order with 403 Forbidden', async () => {
      // Customer A places order
      const { order } = await ordersService.checkout(
        {
          idempotencyKey: 'alice-order-key-1',
          items: [{ menuItemId: flatWhiteId, quantity: 1, selectedModifierOptionIds: [oatMilkOptId] }],
        },
        'alice-user-id'
      );

      // Customer B logs in
      const customerBToken = app.jwt.sign({
        id: 'bob-user-id',
        email: 'bob@cafe.in',
        role: Role.CUSTOMER,
      });

      // Bob tries snooping on Alice's order
      const snoopResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/${order.id}`,
        headers: { authorization: `Bearer ${customerBToken}` },
      });

      expect(snoopResponse.statusCode).toBe(403);
      expect(snoopResponse.json().code).toBe('FORBIDDEN_ORDER_ACCESS');

      // Staff CAN view Alice's order
      const staffToken = app.jwt.sign({
        id: 'staff-user-id',
        email: 'barista@cafe.in',
        role: Role.STAFF,
      });

      const staffViewResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/${order.id}`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(staffViewResponse.statusCode).toBe(200);
      expect(staffViewResponse.json().order.id).toBe(order.id);
    });
  });
});
