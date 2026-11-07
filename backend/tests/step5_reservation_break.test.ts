import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Role, TableArea, ReservationStatus } from '@prisma/client';
import { buildApp } from '../src/server.js';
import { ReservationsService } from '../src/modules/reservations/reservations.service.js';

function createInMemoryReservationPrisma() {
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
      const next = queue.shift()!;
      next();
    } else {
      isLocked = false;
    }
  };

  const client: any = {
    table: {
      async findMany({ where }: any = {}) {
        let list = Array.from(tables.values());
        if (where?.isActive !== undefined) {
          list = list.filter((t) => t.isActive === where.isActive);
        }
        if (where?.capacity?.gte) {
          list = list.filter((t) => t.capacity >= where.capacity.gte);
        }
        return list.sort((a, b) => a.tableNumber - b.tableNumber);
      },
      async findUnique({ where }: any) {
        return tables.get(where.id) || null;
      },
      async create({ data }: any) {
        const id = data.id || `table-${Date.now()}-${Math.random()}`;
        const t = { id, ...data, isActive: data.isActive ?? true };
        tables.set(id, t);
        return { ...t };
      },
    },
    reservation: {
      async findMany({ where }: any = {}) {
        let list = Array.from(reservations.values());
        if (where?.tableId?.in) {
          list = list.filter((r) => where.tableId.in.includes(r.tableId));
        }
        if (where?.status) {
          list = list.filter((r) => r.status === where.status);
        }
        if (where?.userId) {
          list = list.filter((r) => r.userId === where.userId);
        }
        return list;
      },
      async findFirst({ where }: any) {
        for (const r of reservations.values()) {
          if (r.tableId === where.tableId && r.status === where.status) {
            const rStart = new Date(r.startTime).getTime();
            const rEnd = new Date(r.endTime).getTime();
            const slotStart = new Date(where.endTime.gt).getTime();
            const slotEnd = new Date(where.startTime.lt).getTime();
            // Overlap: existing.startTime < slotEnd AND existing.endTime > slotStart
            if (rStart < slotEnd && rEnd > slotStart) {
              return { ...r };
            }
          }
        }
        return null;
      },
      async findUnique({ where }: any) {
        return reservations.get(where.id) || null;
      },
      async create({ data, include }: any) {
        const id = data.id || `res-${Date.now()}-${Math.random()}`;
        const res = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        reservations.set(id, res);
        const out: any = { ...res };
        if (include?.table) {
          out.table = tables.get(res.tableId);
        }
        return out;
      },
      async update({ where, data, include }: any) {
        const res = reservations.get(where.id);
        if (!res) throw new Error('Reservation not found');
        const updated = { ...res, ...data, updatedAt: new Date() };
        reservations.set(where.id, updated);
        const out: any = { ...updated };
        if (include?.table) {
          out.table = tables.get(res.tableId);
        }
        return out;
      },
    },
    reservationHold: {
      async findMany({ where }: any = {}) {
        let list = Array.from(holds.values());
        if (where?.tableId?.in) {
          list = list.filter((h) => where.tableId.in.includes(h.tableId));
        }
        if (where?.expiresAt?.gt) {
          const threshold = new Date(where.expiresAt.gt).getTime();
          list = list.filter((h) => new Date(h.expiresAt).getTime() > threshold);
        }
        return list;
      },
      async findFirst({ where }: any) {
        const nowTime = where.expiresAt?.gt ? new Date(where.expiresAt.gt).getTime() : 0;
        for (const h of holds.values()) {
          if (h.tableId === where.tableId) {
            const hExpires = new Date(h.expiresAt).getTime();
            if (hExpires > nowTime) {
              const hStart = new Date(h.slotStartTime).getTime();
              const hEnd = new Date(h.slotEndTime).getTime();
              const slotStart = new Date(where.slotEndTime.gt).getTime();
              const slotEnd = new Date(where.slotStartTime.lt).getTime();
              // Overlap: hold.start < slotEnd AND hold.end > slotStart
              if (hStart < slotEnd && hEnd > slotStart) {
                return { ...h };
              }
            }
          }
        }
        return null;
      },
      async findUnique({ where, include }: any) {
        let found: any = null;
        if (where.heldByToken) {
          for (const h of holds.values()) {
            if (h.heldByToken === where.heldByToken) {
              found = h;
              break;
            }
          }
        } else if (where.id) {
          found = holds.get(where.id);
        }
        if (!found) return null;
        const out: any = { ...found };
        if (include?.table) {
          out.table = tables.get(found.tableId);
        }
        return out;
      },
      async create({ data }: any) {
        // Compound unique constraint enforcement: [tableId, slotStartTime]
        for (const h of holds.values()) {
          if (
            h.tableId === data.tableId &&
            new Date(h.slotStartTime).getTime() === new Date(data.slotStartTime).getTime() &&
            new Date(h.expiresAt).getTime() > Date.now()
          ) {
            const err: any = new Error('Unique constraint failed on the fields: (`tableId`,`slotStartTime`)');
            err.code = 'P2002';
            throw err;
          }
        }
        const id = data.id || `hold-${Date.now()}-${Math.random()}`;
        const h = { id, ...data, createdAt: new Date() };
        holds.set(id, h);
        return { ...h };
      },
      async delete({ where }: any) {
        const target = holds.get(where.id);
        if (target) holds.delete(where.id);
        return target;
      },
      async update({ where, data }: any) {
        const target = holds.get(where.id);
        if (!target) throw new Error('Hold not found');
        const updated = { ...target, ...data };
        holds.set(where.id, updated);
        return { ...updated };
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

describe('STEP 5 ADVERSARIAL BREAK TESTS: Zero Double-Booking Reservation Engine', () => {
  let app: FastifyInstance;
  let mockPrisma: any;
  let reservationsService: ReservationsService;

  let table1Id: string;
  let table2Id: string;

  beforeEach(async () => {
    mockPrisma = createInMemoryReservationPrisma();
    reservationsService = new ReservationsService(mockPrisma);
    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();

    // Table 1: 2-seater, Indoor
    const t1 = await mockPrisma.table.create({
      data: { tableNumber: 1, capacity: 2, area: TableArea.INDOOR },
    });
    table1Id = t1.id;

    // Table 2: 4-seater, Patio
    const t2 = await mockPrisma.table.create({
      data: { tableNumber: 2, capacity: 4, area: TableArea.PATIO },
    });
    table2Id = t2.id;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Adversarial Concurrency: 20 Parallel Requests Competing for 1 Slot', () => {
    it('MUST GUARANTEE zero double-booking under extreme concurrency (exactly 1 succeeds, 19 fail with 409)', async () => {
      const concurrentRequests = 20;
      // Tomorrow at 19:00 IST (7:00 PM IST = 13:30 UTC, strictly within 10:00 to 22:00 IST)
      const tomorrow1900 = new Date(Date.now() + 24 * 60 * 60 * 1000);
      tomorrow1900.setUTCHours(13, 30, 0, 0);
      const startTimeIso = tomorrow1900.toISOString();

      // 20 users firing parallel hold requests at the exact same millisecond
      const results = await Promise.allSettled(
        Array.from({ length: concurrentRequests }, (_, i) =>
          reservationsService.holdSlot({
            tableId: table1Id,
            guestCount: 2,
            startTime: startTimeIso,
            durationMinutes: 60,
            customerName: `Concurrent Guest ${i + 1}`,
            customerEmail: `guest${i + 1}@example.in`,
            customerPhone: `+9198765432${i < 10 ? '0' + i : i}`,
          })
        )
      );

      const successfulHolds = results.filter((r) => r.status === 'fulfilled');
      const rejectedHolds = results.filter((r) => r.status === 'rejected');

      // CRITICAL ASSERTION: Exactly 1 client gets the lock
      expect(successfulHolds.length, 'Only 1 request MUST succeed in locking the slot').toBe(1);
      expect(rejectedHolds.length, 'Remaining 19 requests MUST fail').toBe(19);

      for (const rej of rejectedHolds) {
        if (rej.status === 'rejected') {
          const err = rej.reason as any;
          expect([409, 500]).toContain(err.statusCode || (err.code === 'P2002' ? 409 : 500));
          expect(err.code === 'SLOT_ALREADY_HELD' || err.code === 'P2002').toBe(true);
        }
      }

      // Verify that database has exactly 1 hold record for this slot
      const allHolds = await mockPrisma.reservationHold.findMany();
      expect(allHolds.length, 'Database MUST contain strictly 1 hold record, never duplicates').toBe(1);
    });
  });

  describe('Adversarial Overlapping Time Intervals Conflict Detection', () => {
    it('MUST BLOCK overlapping time intervals on the same table (partial overlap defense)', async () => {
      const baseTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      baseTime.setUTCHours(12, 30, 0, 0); // 18:00 IST (6:00 PM IST)

      // 1. User A holds 18:00 to 19:30 (90 mins duration)
      const holdA = await reservationsService.holdSlot({
        tableId: table1Id,
        guestCount: 2,
        startTime: baseTime.toISOString(),
        durationMinutes: 90, // Ends at 19:30
        customerName: 'User A',
        customerEmail: 'usera@example.in',
        customerPhone: '+919999999901',
      });
      expect(holdA.holdToken).toBeDefined();

      // Attack 1: User B tries to hold 18:30 to 19:30 (starts while User A is dining)
      const attackTime1 = new Date(baseTime.getTime() + 30 * 60 * 1000); // 18:30
      await expect(
        reservationsService.holdSlot({
          tableId: table1Id,
          guestCount: 2,
          startTime: attackTime1.toISOString(),
          durationMinutes: 60,
          customerName: 'Attacker B',
          customerEmail: 'userb@example.in',
          customerPhone: '+919999999902',
        })
      ).rejects.toMatchObject({
        code: 'SLOT_ALREADY_HELD',
        statusCode: 409,
      });

      // Attack 2: User C tries to hold 17:30 to 18:30 (ends after User A starts)
      const attackTime2 = new Date(baseTime.getTime() - 30 * 60 * 1000); // 17:30
      await expect(
        reservationsService.holdSlot({
          tableId: table1Id,
          guestCount: 2,
          startTime: attackTime2.toISOString(),
          durationMinutes: 60, // Ends at 18:30 (overlaps with 18:00 - 19:30)
          customerName: 'Attacker C',
          customerEmail: 'userc@example.in',
          customerPhone: '+919999999903',
        })
      ).rejects.toMatchObject({
        code: 'SLOT_ALREADY_HELD',
        statusCode: 409,
      });

      // Valid Non-overlapping: User D holds 19:30 to 20:30 (starts exactly when User A ends)
      const validTime = new Date(baseTime.getTime() + 90 * 60 * 1000); // 19:30
      const holdD = await reservationsService.holdSlot({
        tableId: table1Id,
        guestCount: 2,
        startTime: validTime.toISOString(),
        durationMinutes: 60,
        customerName: 'Legitimate User D',
        customerEmail: 'userd@example.in',
        customerPhone: '+919999999904',
      });
      expect(holdD.holdToken).toBeDefined();
    });
  });

  describe('Adversarial Expired Hold Reclamation & Double Confirmation', () => {
    it('MUST REJECT confirmation of an expired hold with 410 HOLD_EXPIRED and allow slot reclamation', async () => {
      const tomorrowTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      tomorrowTime.setUTCHours(8, 30, 0, 0); // 14:00 IST (2:00 PM IST)

      // 1. Create a hold
      const hold = await reservationsService.holdSlot({
        tableId: table1Id,
        guestCount: 2,
        startTime: tomorrowTime.toISOString(),
        durationMinutes: 60,
        customerName: 'Slow Confirm User',
        customerEmail: 'slow@example.in',
        customerPhone: '+919999999905',
      });

      // 2. Simulate hold expiration (11 minutes passed)
      const holdInDb = await mockPrisma.reservationHold.findUnique({
        where: { heldByToken: hold.holdToken },
      });
      await mockPrisma.reservationHold.update({
        where: { id: holdInDb.id },
        data: { expiresAt: new Date(Date.now() - 60000) }, // Expired 1 minute ago
      });

      // 3. Attempt to confirm expired hold
      await expect(
        reservationsService.confirmReservation(
          { holdToken: hold.holdToken },
          {
            customerName: 'Slow Confirm User',
            customerEmail: 'slow@example.in',
            customerPhone: '+919999999905',
            guestCount: 2,
          }
        )
      ).rejects.toMatchObject({
        code: 'HOLD_EXPIRED',
        statusCode: 410,
      });

      // 4. Verification: Slot is now reclaimed by a new user without being blocked
      const freshHold = await reservationsService.holdSlot({
        tableId: table1Id,
        guestCount: 2,
        startTime: tomorrowTime.toISOString(),
        durationMinutes: 60,
        customerName: 'Prompt User',
        customerEmail: 'prompt@example.in',
        customerPhone: '+919999999906',
      });
      expect(freshHold.holdToken).toBeDefined();
    });

    it('MUST PREVENT double confirmation replay attack with the same holdToken', async () => {
      const tomorrowTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      tomorrowTime.setUTCHours(10, 30, 0, 0); // 16:00 IST (4:00 PM IST)

      const hold = await reservationsService.holdSlot({
        tableId: table2Id,
        guestCount: 4,
        startTime: tomorrowTime.toISOString(),
        durationMinutes: 60,
        customerName: 'Single Confirm User',
        customerEmail: 'single@example.in',
        customerPhone: '+919999999907',
      });

      // 1st confirmation: SUCCEEDS
      const confirmed = await reservationsService.confirmReservation(
        { holdToken: hold.holdToken },
        {
          customerName: 'Single Confirm User',
          customerEmail: 'single@example.in',
          customerPhone: '+919999999907',
          guestCount: 4,
        }
      );
      expect(confirmed.status).toBe(ReservationStatus.CONFIRMED);

      // 2nd confirmation: MUST FAIL with HOLD_NOT_FOUND
      await expect(
        reservationsService.confirmReservation(
          { holdToken: hold.holdToken },
          {
            customerName: 'Single Confirm User',
            customerEmail: 'single@example.in',
            customerPhone: '+919999999907',
            guestCount: 4,
          }
        )
      ).rejects.toMatchObject({
        code: 'HOLD_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('Adversarial Capacity & Horizontal Access Control', () => {
    it('MUST REJECT booking when guest count exceeds table capacity', async () => {
      const tomorrowTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      tomorrowTime.setUTCHours(6, 30, 0, 0); // 12:00 IST (12:00 PM IST)

      // Table 1 has capacity 2, user requests 6 guests
      await expect(
        reservationsService.holdSlot({
          tableId: table1Id,
          guestCount: 6, // Exceeds capacity!
          startTime: tomorrowTime.toISOString(),
          durationMinutes: 60,
          customerName: 'Greedy Guest',
          customerEmail: 'greedy@example.in',
          customerPhone: '+919999999908',
        })
      ).rejects.toMatchObject({
        code: 'TABLE_CAPACITY_EXCEEDED',
        statusCode: 400,
      });
    });

    it('MUST BLOCK Customer B from cancelling Customer A’s reservation with 403 Forbidden', async () => {
      const tomorrowTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      tomorrowTime.setUTCHours(9, 30, 0, 0); // 15:00 IST (3:00 PM IST)

      // Customer A books Table 1
      const hold = await reservationsService.holdSlot({
        tableId: table1Id,
        guestCount: 2,
        startTime: tomorrowTime.toISOString(),
        durationMinutes: 60,
        customerName: 'Customer Alice',
        customerEmail: 'alice@example.in',
        customerPhone: '+919999999909',
      });

      const reservation = await reservationsService.confirmReservation(
        { holdToken: hold.holdToken },
        {
          customerName: 'Customer Alice',
          customerEmail: 'alice@example.in',
          customerPhone: '+919999999909',
          guestCount: 2,
        },
        'alice-user-id'
      );

      // Bob logs in
      const bobToken = app.jwt.sign({
        id: 'bob-user-id',
        email: 'bob@example.in',
        role: Role.CUSTOMER,
      });

      // Bob attempts to cancel Alice's booking
      const cancelRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/reservations/${reservation.id}/cancel`,
        headers: { authorization: `Bearer ${bobToken}` },
      });

      expect(cancelRes.statusCode).toBe(403);
      expect(cancelRes.json().code).toBe('FORBIDDEN_RESERVATION_ACCESS');

      // Staff logs in and CAN cancel
      const staffToken = app.jwt.sign({
        id: 'staff-user-id',
        email: 'staff@example.in',
        role: Role.STAFF,
      });

      const staffCancelRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/reservations/${reservation.id}/cancel`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(staffCancelRes.statusCode).toBe(200);
      expect(staffCancelRes.json().reservation.status).toBe(ReservationStatus.CANCELLED);
    });
  });
});
