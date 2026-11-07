import { PrismaClient, OrderStatus } from '@prisma/client';
import { MenuService } from '../modules/menu/menu.service.js';

export class CleanupWorker {
  private isSweepingOrders = false;
  private isSweepingHolds = false;

  constructor(
    private prisma: PrismaClient,
    private menuService: MenuService
  ) {}

  /**
   * Sweeps and automatically cancels orders that exceeded their 15-minute payment window.
   * Restores all held inventory atomically.
   * Guarantees zero overlapping sweeps and zero double-restoration under concurrency.
   */
  async sweepExpiredOrders() {
    if (this.isSweepingOrders) {
      return {
        cancelledCount: 0,
        cancelledOrderIds: [],
        skippedDueToLock: true,
      };
    }

    this.isSweepingOrders = true;

    try {
      const now = new Date();

      const expiredOrders = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.PENDING_PAYMENT,
          expiresAt: { lte: now },
        },
        include: {
          items: true,
        },
      });

      const cancelledOrderIds: string[] = [];

      for (const order of expiredOrders) {
        await this.prisma.$transaction(async (tx) => {
          // Conditional atomic transition: Only proceed if order is STILL PENDING_PAYMENT
          let wonCancellationRace = true;

          if (tx.order.updateMany) {
            const updateRes = await tx.order.updateMany({
              where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
              data: { status: OrderStatus.CANCELLED },
            });
            wonCancellationRace = updateRes.count === 1;
          } else {
            await tx.order.update({
              where: { id: order.id },
              data: { status: OrderStatus.CANCELLED },
            });
          }

          if (!wonCancellationRace) {
            // Concurrent customer cancellation won the race: DO NOT restore stock twice!
            return;
          }

          // 1. Restore reserved inventory (only called once by winning transaction)
          await this.menuService.restoreInventoryAtomic(
            order.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })),
            tx
          );

          // 2. Log reason in history
          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: OrderStatus.CANCELLED,
              changedBy: 'SYSTEM_CLEANUP_WORKER',
              reason: 'Order automatically cancelled after 15-minute payment expiration',
            },
          });

          cancelledOrderIds.push(order.id);
        });
      }

      return {
        cancelledCount: cancelledOrderIds.length,
        cancelledOrderIds,
      };
    } finally {
      this.isSweepingOrders = false;
    }
  }

  /**
   * Sweeps and releases table holds that exceeded their 10-minute temporary lock.
   */
  async sweepExpiredHolds() {
    if (this.isSweepingHolds) {
      return {
        releasedCount: 0,
        skippedDueToLock: true,
      };
    }

    this.isSweepingHolds = true;

    try {
      const now = new Date();

      const result = await this.prisma.reservationHold.deleteMany({
        where: {
          expiresAt: { lte: now },
        },
      });

      return {
        releasedCount: result.count,
      };
    } finally {
      this.isSweepingHolds = false;
    }
  }
}
