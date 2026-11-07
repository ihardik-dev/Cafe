import { PrismaClient, OrderStatus } from '@prisma/client';
import { MenuService } from '../modules/menu/menu.service.js';

export class CleanupWorker {
  constructor(
    private prisma: PrismaClient,
    private menuService: MenuService
  ) {}

  /**
   * Sweeps and automatically cancels orders that exceeded their 15-minute payment window.
   * Restores all held inventory atomically.
   */
  async sweepExpiredOrders() {
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
        // 1. Restore reserved inventory
        await this.menuService.restoreInventoryAtomic(
          order.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })),
          tx
        );

        // 2. Mark order as CANCELLED
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.CANCELLED },
        });

        // 3. Log reason in history
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
  }

  /**
   * Sweeps and releases table holds that exceeded their 10-minute temporary lock.
   */
  async sweepExpiredHolds() {
    const now = new Date();

    const result = await this.prisma.reservationHold.deleteMany({
      where: {
        expiresAt: { lte: now },
      },
    });

    return {
      releasedCount: result.count,
    };
  }
}
