import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';
import { PaymentsService } from '../src/modules/payments/payments.service.js';
import { MenuService } from '../src/modules/menu/menu.service.js';
import { ReservationsService } from '../src/modules/reservations/reservations.service.js';
import { checkoutRequestSchema } from '../src/modules/orders/orders.schema.js';
import { envSchema } from '../src/config/env.js';
import { Role, OrderStatus, RefundStatus, ReservationStatus, TableArea } from '@prisma/client';

function createBatch4MockPrisma() {
  const categories: Map<string, any> = new Map();
  const menuItems: Map<string, any> = new Map();
  const inventoryItems: Map<string, any> = new Map();
  const orders: Map<string, any> = new Map();
  const orderItems: Map<string, any> = new Map();
  const orderStatusHistory: Map<string, any> = new Map();
  const tables: Map<string, any> = new Map();
  const reservations: Map<string, any> = new Map();
  const holds: Map<string, any> = new Map();
  const refundAudits: Map<string, any> = new Map();

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
          if (where.status) {
            if (typeof where.status === 'object' && where.status.in) {
              if (!where.status.in.includes(ord.status)) continue;
            } else if (ord.status !== where.status) {
              continue;
            }
          }
          const updated = { ...ord, ...data, updatedAt: new Date() };
          orders.set(id, updated);
          count++;
        }
        return { count };
      },
    },
    refundAudit: {
      async create({ data }: any) {
        const id = `rfnd-audit-${Date.now()}-${Math.random()}`;
        const audit = { id, ...data, createdAt: new Date() };
        refundAudits.set(id, audit);
        return { ...audit };
      },
      async findUnique({ where }: any) {
        if (where.idempotencyKey) {
          for (const a of refundAudits.values()) {
            if (a.idempotencyKey === where.idempotencyKey) {
              return { ...a };
            }
          }
        }
        if (where.id) {
          return refundAudits.get(where.id) || null;
        }
        return null;
      },
      async findMany({ where }: any) {
        let list = Array.from(refundAudits.values());
        if (where?.orderId) {
          list = list.filter((a) => a.orderId === where.orderId);
        }
        if (where?.status?.in) {
          list = list.filter((a) => where.status.in.includes(a.status));
        }
        return list.map((a) => ({ ...a }));
      },
      async update({ where, data }: any) {
        const a = refundAudits.get(where.id);
        if (!a) throw new Error('RefundAudit not found');
        const updated = { ...a, ...data, updatedAt: new Date() };
        refundAudits.set(where.id, updated);
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
    },
    reservation: {
      async create({ data }: any) {
        const id = data.id || `res-${Date.now()}-${Math.random()}`;
        const res = { id, ...data, createdAt: new Date() };
        reservations.set(id, res);
        return { ...res };
      },
      async findUnique({ where, include }: any) {
        const res = reservations.get(where.id);
        if (!res) return null;
        const copy = { ...res };
        if (include?.table) copy.table = tables.get(res.tableId);
        return copy;
      },
      async update({ where, data }: any) {
        const res = reservations.get(where.id);
        if (!res) throw new Error('Reservation not found');
        const updated = { ...res, ...data, updatedAt: new Date() };
        reservations.set(where.id, updated);
        return { ...updated, table: tables.get(updated.tableId) };
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const [id, res] of reservations.entries()) {
          if (where.id && id !== where.id) continue;
          if (where.status && res.status !== where.status) continue;
          const updated = { ...res, ...data, updatedAt: new Date() };
          reservations.set(id, updated);
          count++;
        }
        return { count };
      },
    },
    $queryRaw: async (query: any) => {
      return [{ id: 'mock-table-id' }];
    },
    $transaction: async (fn: any) => {
      await acquireLock();
      try {
        return await fn(client);
      } finally {
        releaseLock();
      }
    },
  };

  return client;
}

describe('STEP 14: BATCH 4 CODE REVIEW VERIFICATION — Hardening, Safe Dual-Phase Refunds & Invariants', () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = createBatch4MockPrisma();
  });

  // --------------------------------------------------------------------------
  // SECTION 1: DUAL-PHASE FINANCIAL REFUND ENGINE & CUMULATIVE BALANCE CAP
  // --------------------------------------------------------------------------
  describe('1. Dual-Phase Financial Refund Engine & Cumulative Balance Cap', () => {
    it('MUST execute gateway refund call outside DB transaction and finalize status to SUCCEEDED', async () => {
      // Create confirmed order
      const order = await mockPrisma.order.create({
        data: {
          orderNumber: 'CAFE-20261107-REF1',
          status: OrderStatus.CONFIRMED,
          subtotalInPaise: 24000,
          taxInPaise: 1200,
          totalInPaise: 25200, // ₹252.00
          paymentIntentId: 'order_rzp_intent_101',
          paymentId: 'pay_rzp_legit_payment_101',
          expiresAt: new Date(Date.now() + 900000),
        },
      });

      // Mock gateway refund
      let gatewayCallCount = 0;
      const mockGateway = {
        payments: {
          refund: async (paymentId: string, payload: any) => {
            gatewayCallCount++;
            expect(paymentId).toBe('pay_rzp_legit_payment_101');
            expect(payload.amount).toBe(25200);
            return {
              id: 'rfnd_gateway_success_999',
              amount: payload.amount,
              status: 'processed',
            };
          },
        },
      };

      const paymentsService = new PaymentsService(mockPrisma, mockGateway);
      const result = await paymentsService.issueManualRefund(
        order.id,
        'Customer order damaged in delivery',
        'admin_user_1',
        'idem_refund_key_001'
      );

      expect(gatewayCallCount).toBe(1);
      expect(result.refund.status).toBe(RefundStatus.SUCCEEDED);
      expect(result.refund.gatewayRefundId).toBe('rfnd_gateway_success_999');

      // Check order in DB
      const dbOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder.status).toBe(OrderStatus.REFUNDED);

      // Check audit in DB
      const audits = await mockPrisma.refundAudit.findMany({ where: { orderId: order.id } });
      expect(audits.length).toBe(1);
      expect(audits[0].status).toBe(RefundStatus.SUCCEEDED);
      expect(audits[0].gatewayRefundId).toBe('rfnd_gateway_success_999');
    });

    it('MUST record FAILED in DB and restore order status if gateway refund call fails (Never claim fake success)', async () => {
      const order = await mockPrisma.order.create({
        data: {
          orderNumber: 'CAFE-20261107-REF2',
          status: OrderStatus.CONFIRMED,
          subtotalInPaise: 18000,
          taxInPaise: 900,
          totalInPaise: 18900,
          paymentIntentId: 'order_rzp_intent_102',
          paymentId: 'pay_rzp_failing_102',
          expiresAt: new Date(Date.now() + 900000),
        },
      });

      const failingGateway = {
        payments: {
          refund: async () => {
            const err: any = new Error('Gateway network timeout contacting card network');
            err.statusCode = 502;
            throw err;
          },
        },
      };

      const paymentsService = new PaymentsService(mockPrisma, failingGateway);

      await expect(
        paymentsService.issueManualRefund(
          order.id,
          'Test refund failure',
          'admin_user_1',
          'idem_refund_fail_001'
        )
      ).rejects.toMatchObject({
        code: 'GATEWAY_REFUND_FAILED',
        statusCode: 502,
      });

      // Verify that order is NOT marked REFUNDED
      const dbOrder = await mockPrisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder.status).toBe(OrderStatus.CONFIRMED);

      // Verify that audit log records FAILED
      const audits = await mockPrisma.refundAudit.findMany({ where: { orderId: order.id } });
      expect(audits.length).toBe(1);
      expect(audits[0].status).toBe(RefundStatus.FAILED);
      expect(audits[0].reason).toContain('MANUAL_ADMIN_REFUND_FAILED');
    });

    it('MUST prevent double refund under extreme concurrency (2 admins refunding simultaneously)', async () => {
      const order = await mockPrisma.order.create({
        data: {
          orderNumber: 'CAFE-20261107-REF3',
          status: OrderStatus.CONFIRMED,
          subtotalInPaise: 30000,
          taxInPaise: 1500,
          totalInPaise: 31500,
          paymentIntentId: 'order_rzp_intent_103',
          paymentId: 'pay_rzp_concurrent_103',
          expiresAt: new Date(Date.now() + 900000),
        },
      });

      let gatewayCallCount = 0;
      const slowGateway = {
        payments: {
          refund: async (paymentId: string, payload: any) => {
            gatewayCallCount++;
            await new Promise((r) => setTimeout(r, 20));
            return {
              id: `rfnd_slow_${Date.now()}`,
              amount: payload.amount,
            };
          },
        },
      };

      const paymentsService = new PaymentsService(mockPrisma, slowGateway);

      const [res1, res2] = await Promise.allSettled([
        paymentsService.issueManualRefund(order.id, 'Admin 1 refund', 'admin_1'),
        paymentsService.issueManualRefund(order.id, 'Admin 2 refund', 'admin_2'),
      ]);

      const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
      const failures = [res1, res2].filter((r) => r.status === 'rejected');

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect(gatewayCallCount).toBe(1); // Gateway called strictly ONCE
    });

    it('MUST return idempotent result when retried with same idempotencyKey without re-calling gateway', async () => {
      const order = await mockPrisma.order.create({
        data: {
          orderNumber: 'CAFE-20261107-REF4',
          status: OrderStatus.CONFIRMED,
          subtotalInPaise: 15000,
          taxInPaise: 750,
          totalInPaise: 15750,
          paymentIntentId: 'order_rzp_intent_104',
          paymentId: 'pay_rzp_idem_104',
          expiresAt: new Date(Date.now() + 900000),
        },
      });

      let gatewayCallCount = 0;
      const mockGateway = {
        payments: {
          refund: async () => {
            gatewayCallCount++;
            return { id: 'rfnd_idem_gateway_888' };
          },
        },
      };

      const paymentsService = new PaymentsService(mockPrisma, mockGateway);

      // Attempt 1
      const result1 = await paymentsService.issueManualRefund(
        order.id,
        'Original customer request',
        'admin_1',
        'idem_key_retry_104'
      );
      expect(gatewayCallCount).toBe(1);
      expect(result1.refund.status).toBe(RefundStatus.SUCCEEDED);

      // Attempt 2 with same idempotencyKey
      const result2 = await paymentsService.issueManualRefund(
        order.id,
        'Original customer request',
        'admin_1',
        'idem_key_retry_104'
      );

      expect(gatewayCallCount).toBe(1); // Still strictly 1! Gateway was NOT re-called!
      expect(result2.refund.isDuplicate).toBe(true);
      expect(result2.refund.gatewayRefundId).toBe('rfnd_idem_gateway_888');
    });

    it('MUST REJECT partial refund that exceeds cumulative order total', async () => {
      const order = await mockPrisma.order.create({
        data: {
          orderNumber: 'CAFE-20261107-REF5',
          status: OrderStatus.CONFIRMED,
          subtotalInPaise: 10000,
          taxInPaise: 500,
          totalInPaise: 10500, // ₹105.00
          paymentIntentId: 'order_rzp_intent_105',
          paymentId: 'pay_rzp_partial_105',
          expiresAt: new Date(Date.now() + 900000),
        },
      });

      // Seed an existing succeeded partial refund of ₹80.00 (8000 paise)
      await mockPrisma.refundAudit.create({
        data: {
          orderId: order.id,
          paymentIntentId: 'order_rzp_intent_105',
          amountInPaise: 8000,
          reason: 'Partial refund 1',
          status: RefundStatus.SUCCEEDED,
          gatewayRefundId: 'rfnd_partial_1',
        },
      });

      const paymentsService = new PaymentsService(mockPrisma);

      // Attempting to refund another ₹50.00 (5000 paise) when only ₹25.00 remains
      await expect(
        paymentsService.issueManualRefund(
          order.id,
          'Second partial refund',
          'admin_1',
          'idem_part_2',
          5000 // 8000 + 5000 = 13000 > 10500
        )
      ).rejects.toMatchObject({
        code: 'REFUND_EXCEEDS_PAYMENT_AMOUNT',
        statusCode: 400,
      });
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 2: PERISHABLE INVENTORY FAIL-CLOSED PROTECTION
  // --------------------------------------------------------------------------
  describe('2. Perishable Inventory Fail-Closed Protection', () => {
    it('MUST throw 500 INVENTORY_RECORD_MISSING when a perishable item has no inventory record (fails closed)', async () => {
      const category = await mockPrisma.category.create({
        data: { name: 'Artisan Pastries' },
      });

      // Create a perishable menu item WITHOUT an inventory record
      const item = await mockPrisma.menuItem.create({
        data: {
          categoryId: category.id,
          name: 'Rare Saffron Brioche',
          priceInPaise: 35000,
          isPerishable: true, // Marked perishable!
        },
      });

      const menuService = new MenuService(mockPrisma);

      // Attempting to deduct inventory MUST fail closed!
      await expect(
        menuService.deductInventoryAtomic([{ menuItemId: item.id, quantity: 1 }])
      ).rejects.toMatchObject({
        code: 'INVENTORY_RECORD_MISSING',
        statusCode: 500,
      });
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 3: DUPLICATE MODIFIER SELECTION VALIDATION
  // --------------------------------------------------------------------------
  describe('3. Duplicate Modifier Selection Validation', () => {
    it('MUST reject checkout request with duplicate modifier options for the same item with 400', () => {
      const invalidPayload = {
        idempotencyKey: 'idem_test_duplicate_mod_001',
        items: [
          {
            menuItemId: 'item-flat-white-1',
            quantity: 1,
            selectedModifierOptionIds: [
              'opt-oat-milk',
              'opt-oat-milk', // Duplicate modifier ID!
            ],
          },
        ],
      };

      const result = checkoutRequestSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some((i) => i.message.includes('Duplicate modifier options are not permitted'))).toBe(true);
      }
    });

    it('MUST accept checkout request when all modifier options are distinct', () => {
      const validPayload = {
        idempotencyKey: 'idem_test_distinct_mod_001',
        items: [
          {
            menuItemId: 'item-flat-white-1',
            quantity: 1,
            selectedModifierOptionIds: [
              'opt-oat-milk',
              'opt-extra-shot', // Distinct modifiers
            ],
          },
        ],
      };

      const result = checkoutRequestSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 4: RESERVATION STATE MACHINE IMMUTABILITY
  // --------------------------------------------------------------------------
  describe('4. Reservation State Machine Immutability', () => {
    it('MUST block cancellation of a COMPLETED reservation with 422 RESERVATION_ALREADY_COMPLETED', async () => {
      const table = await mockPrisma.table.create({
        data: { tableNumber: 99, capacity: 4, area: TableArea.INDOOR },
      });

      const reservation = await mockPrisma.reservation.create({
        data: {
          tableId: table.id,
          customerName: 'Aarav Sharma',
          customerEmail: 'aarav@example.com',
          customerPhone: '+919876543210',
          guestCount: 2,
          startTime: new Date(Date.now() - 7200000),
          endTime: new Date(Date.now() - 3600000),
          status: ReservationStatus.COMPLETED, // Dining already finished!
        },
      });

      const reservationsService = new ReservationsService(mockPrisma);

      await expect(
        reservationsService.cancelReservation(reservation.id, { role: Role.ADMIN })
      ).rejects.toMatchObject({
        code: 'RESERVATION_ALREADY_COMPLETED',
        statusCode: 422,
      });
    });

    it('MUST block double cancellation concurrently (second request gets 400 ALREADY_CANCELLED)', async () => {
      const table = await mockPrisma.table.create({
        data: { tableNumber: 98, capacity: 4, area: TableArea.INDOOR },
      });

      const reservation = await mockPrisma.reservation.create({
        data: {
          tableId: table.id,
          customerName: 'Rohan Mehta',
          customerEmail: 'rohan@example.com',
          customerPhone: '+919876543211',
          guestCount: 2,
          startTime: new Date(Date.now() + 3600000),
          endTime: new Date(Date.now() + 7200000),
          status: ReservationStatus.CONFIRMED,
        },
      });

      const reservationsService = new ReservationsService(mockPrisma);

      const [res1, res2] = await Promise.allSettled([
        reservationsService.cancelReservation(reservation.id, { role: Role.ADMIN }),
        reservationsService.cancelReservation(reservation.id, { role: Role.ADMIN }),
      ]);

      const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
      const failures = [res1, res2].filter((r) => r.status === 'rejected');

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      const failedReason: any = (failures[0] as PromiseRejectedResult).reason;
      expect(failedReason.code).toBe('ALREADY_CANCELLED');
      expect(failedReason.statusCode).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 5: STRICT PRODUCTION CORS & ENVIRONMENT CONFIGURATION
  // --------------------------------------------------------------------------
  describe('5. Strict Production CORS & Environment Configuration', () => {
    it('MUST reject wildcard CORS ("*") in production environment with credentials', () => {
      const prodWildcardEnv = {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://cafe_user:pass@localhost:5432/cafe_db',
        JWT_SECRET: 'super_secret_jwt_key_that_is_32_characters_long_12345',
        JWT_REFRESH_SECRET: 'super_secret_jwt_refresh_key_32_characters_12345',
        CORS_ORIGIN: '*', // Wildcard in production!
      };

      const result = envSchema.safeParse(prodWildcardEnv);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) =>
            i.message.includes('Wildcard CORS ("*") is not permitted in production')
          )
        ).toBe(true);
      }
    });

    it('MUST accept explicit domains in production CORS_ORIGIN', () => {
      const prodExplicitEnv = {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://cafe_user:pass@localhost:5432/cafe_db',
        JWT_SECRET: 'super_secret_jwt_key_that_is_32_characters_long_12345',
        JWT_REFRESH_SECRET: 'super_secret_jwt_refresh_key_32_characters_12345',
        CORS_ORIGIN: 'https://cafe.example.com, https://admin.cafe.example.com',
      };

      const result = envSchema.safeParse(prodExplicitEnv);
      expect(result.success).toBe(true);
    });
  });
});
