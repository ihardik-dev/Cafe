import { PrismaClient, ReservationStatus, Role } from '@prisma/client';
import crypto from 'crypto';
import { HoldReservationInput, ConfirmReservationInput } from './reservations.schema.js';

export class ReservationsService {
  constructor(private prisma: PrismaClient) {}

  // ----------------------------------------------------
  // LIST TABLES & CHECK AVAILABLE SLOTS
  // ----------------------------------------------------

  async getTables() {
    return this.prisma.table.findMany({
      where: { isActive: true },
      orderBy: { tableNumber: 'asc' },
    });
  }

  async getAvailableSlots(dateStr: string, guestCount: number) {
    // 1. Find all active tables that can seat this party
    const candidateTables = await this.prisma.table.findMany({
      where: {
        isActive: true,
        capacity: { gte: guestCount },
      },
      orderBy: { capacity: 'asc' },
    });

    if (candidateTables.length === 0) {
      return {
        date: dateStr,
        guestCount,
        availableTables: [],
        message: `No tables available for parties of ${guestCount}. Please contact the cafe directly for large parties.`,
      };
    }

    // 2. Define cafe operating hours in Indian Standard Time (10:00 AM to 10:00 PM IST / UTC+05:30)
    // 10:00 AM IST is 04:30:00.000Z; 10:00 PM IST is 16:30:00.000Z
    const dayStart = new Date(`${dateStr}T10:00:00+05:30`);
    const dayEnd = new Date(`${dateStr}T22:00:00+05:30`);
    const now = new Date();

    // 3. Fetch all confirmed reservations and unexpired holds for candidate tables on this day
    const candidateTableIds = candidateTables.map((t) => t.id);

    const existingReservations = await this.prisma.reservation.findMany({
      where: {
        tableId: { in: candidateTableIds },
        status: ReservationStatus.CONFIRMED,
        startTime: { lt: dayEnd },
        endTime: { gt: dayStart },
      },
    });

    const activeHolds = await this.prisma.reservationHold.findMany({
      where: {
        tableId: { in: candidateTableIds },
        expiresAt: { gt: now },
        slotStartTime: { lt: dayEnd },
        slotEndTime: { gt: dayStart },
      },
    });

    // 4. Calculate available 1-hour slots for each table
    const resultTables = candidateTables.map((table) => {
      const slots: { startTime: string; endTime: string }[] = [];

      // Loop hourly from 10:00 to 21:00
      let slotStart = new Date(dayStart);
      while (slotStart.getTime() + 60 * 60 * 1000 <= dayEnd.getTime()) {
        const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

        // Don't show slots in the past
        if (slotStart.getTime() > now.getTime()) {
          // Check for conflicts: overlap condition (existing.start < slotEnd && existing.end > slotStart)
          const hasBookingConflict = existingReservations.some(
            (r) =>
              r.tableId === table.id &&
              new Date(r.startTime).getTime() < slotEnd.getTime() &&
              new Date(r.endTime).getTime() > slotStart.getTime()
          );

          const hasHoldConflict = activeHolds.some(
            (h) =>
              h.tableId === table.id &&
              new Date(h.slotStartTime).getTime() < slotEnd.getTime() &&
              new Date(h.slotEndTime).getTime() > slotStart.getTime()
          );

          if (!hasBookingConflict && !hasHoldConflict) {
            slots.push({
              startTime: slotStart.toISOString(),
              endTime: slotEnd.toISOString(),
            });
          }
        }

        // Advance by 1 hour
        slotStart = new Date(slotStart.getTime() + 60 * 60 * 1000);
      }

      return {
        tableId: table.id,
        tableNumber: table.tableNumber,
        capacity: table.capacity,
        area: table.area,
        availableSlots: slots,
      };
    });

    return {
      date: dateStr,
      guestCount,
      tables: resultTables,
    };
  }

  // ----------------------------------------------------
  // CONCURRENCY DEFENSE: 10-MINUTE HOLD
  // ----------------------------------------------------

  /**
   * Places a 10-minute temporary lock on a table slot.
   * Uses an atomic transaction and conflict detection to ensure zero double-booking.
   */
  async holdSlot(input: HoldReservationInput, _userId?: string) {
    const slotStart = new Date(input.startTime);
    const slotEnd = new Date(slotStart.getTime() + input.durationMinutes * 60 * 1000);
    const now = new Date();

    if (slotStart.getTime() <= now.getTime()) {
      const err: any = new Error('Cannot book a reservation in the past');
      err.statusCode = 400;
      err.code = 'RESERVATION_IN_PAST';
      throw err;
    }

    // Operating hours enforcement in Indian Standard Time (IST, UTC+05:30)
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istStart = new Date(slotStart.getTime() + IST_OFFSET_MS);
    const istEnd = new Date(slotEnd.getTime() + IST_OFFSET_MS);

    const startMinutes = istStart.getUTCHours() * 60 + istStart.getUTCMinutes();
    const endMinutes = istEnd.getUTCHours() * 60 + istEnd.getUTCMinutes();

    // 10:00 AM IST = 600 mins; 10:00 PM IST = 1320 mins (22:00)
    if (
      startMinutes < 600 ||
      endMinutes > 1320 ||
      istStart.getUTCDate() !== istEnd.getUTCDate()
    ) {
      const err: any = new Error(
        'Reservation time must be within cafe operating hours (10:00 AM to 10:00 PM IST)'
      );
      err.statusCode = 400;
      err.code = 'OUTSIDE_OPERATING_HOURS';
      throw err;
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Verify Table exists, is active, and can seat the guests
      const table = await tx.table.findUnique({
        where: { id: input.tableId },
      });

      if (!table || !table.isActive) {
        const err: any = new Error('Table not found or is currently inactive');
        err.statusCode = 404;
        err.code = 'TABLE_NOT_FOUND';
        throw err;
      }

      // Serialize concurrent booking attempts on this table using PostgreSQL row-level lock
      try {
        await tx.$executeRawUnsafe(`SELECT id FROM "Table" WHERE id = $1 FOR UPDATE`, table.id);
      } catch {
        // Fallback for in-memory mocks
      }

      if (table.capacity < input.guestCount) {
        const err: any = new Error(
          `Table #${table.tableNumber} has a maximum capacity of ${table.capacity} guests. Cannot book for ${input.guestCount} guests.`
        );
        err.statusCode = 400;
        err.code = 'TABLE_CAPACITY_EXCEEDED';
        throw err;
      }

      // 2. Clear any expired holds on this table so they don't block legitimate bookings
      await tx.reservationHold.deleteMany({
        where: {
          tableId: table.id,
          expiresAt: { lte: now },
        },
      });

      // 3. Overlap check against confirmed reservations
      // Overlap formula: existing.startTime < slotEnd AND existing.endTime > slotStart
      const conflictingBooking = await tx.reservation.findFirst({
        where: {
          tableId: table.id,
          status: ReservationStatus.CONFIRMED,
          startTime: { lt: slotEnd },
          endTime: { gt: slotStart },
        },
      });

      if (conflictingBooking) {
        const err: any = new Error(
          `Table #${table.tableNumber} is already confirmed for another booking during this time interval.`
        );
        err.statusCode = 409;
        err.code = 'SLOT_ALREADY_CONFIRMED';
        throw err;
      }

      // 4. Overlap check against active, unexpired holds
      const conflictingHold = await tx.reservationHold.findFirst({
        where: {
          tableId: table.id,
          expiresAt: { gt: now },
          slotStartTime: { lt: slotEnd },
          slotEndTime: { gt: slotStart },
        },
      });

      if (conflictingHold) {
        const err: any = new Error(
          `Table #${table.tableNumber} is currently held by another guest. Please try another slot or check back in 10 minutes.`
        );
        err.statusCode = 409;
        err.code = 'SLOT_ALREADY_HELD';
        throw err;
      }

      // 5. Generate secure hold token and 10-minute expiration window
      const holdToken = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

      const hold = await tx.reservationHold.create({
        data: {
          tableId: table.id,
          slotStartTime: slotStart,
          slotEndTime: slotEnd,
          heldByToken: holdToken,
          guestCount: input.guestCount,
          expiresAt,
        },
      });

      return {
        holdToken: hold.heldByToken,
        expiresAt: hold.expiresAt,
        table: {
          id: table.id,
          tableNumber: table.tableNumber,
          capacity: table.capacity,
          area: table.area,
        },
        slot: {
          startTime: slotStart.toISOString(),
          endTime: slotEnd.toISOString(),
          durationMinutes: input.durationMinutes,
        },
        guestDetails: {
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          guestCount: input.guestCount,
        },
      };
    });
  }

  // ----------------------------------------------------
  // CONFIRM RESERVATION
  // ----------------------------------------------------

  /**
   * Finalizes the reservation using the unexpired holdToken.
   * Atomically creates the confirmed Reservation and deletes the hold.
   */
  async confirmReservation(
    input: ConfirmReservationInput,
    guestDetails: {
      customerName: string;
      customerEmail: string;
      customerPhone: string;
      guestCount: number;
    },
    userId?: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Fetch hold record
      const hold = await tx.reservationHold.findUnique({
        where: { heldByToken: input.holdToken },
        include: { table: true },
      });

      if (!hold) {
        const err: any = new Error('Hold token not found or already confirmed');
        err.statusCode = 404;
        err.code = 'HOLD_NOT_FOUND';
        throw err;
      }

      // Serialize concurrent confirmation attempts on this table using PostgreSQL row-level lock
      try {
        await tx.$executeRawUnsafe(`SELECT id FROM "Table" WHERE id = $1 FOR UPDATE`, hold.tableId);
      } catch {
        // Fallback for in-memory mocks
      }

      // 2. Verify hold has not expired
      if (new Date(hold.expiresAt).getTime() <= Date.now()) {
        // Clean up expired hold
        await tx.reservationHold.delete({ where: { id: hold.id } });

        const err: any = new Error(
          'Your 10-minute reservation hold has expired. Please select a slot again.'
        );
        err.statusCode = 410;
        err.code = 'HOLD_EXPIRED';
        throw err;
      }

      // 3. Re-verify party size does not exceed table capacity (Fix for Review Issue E)
      if (guestDetails.guestCount > hold.table.capacity) {
        const err: any = new Error(
          `Cannot confirm reservation for ${guestDetails.guestCount} guests. Table ${hold.table.tableNumber} maximum capacity is ${hold.table.capacity}.`
        );
        err.statusCode = 422;
        err.code = 'CAPACITY_EXCEEDED';
        throw err;
      }

      // 4. Re-verify zero interval overlap against any newly confirmed reservations
      const overlapping = await tx.reservation.findFirst({
        where: {
          tableId: hold.tableId,
          status: ReservationStatus.CONFIRMED,
          startTime: { lt: hold.slotEndTime },
          endTime: { gt: hold.slotStartTime },
        },
      });

      if (overlapping) {
        const err: any = new Error(
          'Slot has already been confirmed by another reservation.'
        );
        err.statusCode = 409;
        err.code = 'RESERVATION_CONFLICT';
        throw err;
      }

      // 3. Generate guest access token if guest booking
      let rawGuestToken: string | undefined;
      let guestAccessTokenHash: string | undefined;

      if (!userId) {
        rawGuestToken = `gst_${crypto.randomBytes(24).toString('hex')}`;
        guestAccessTokenHash = crypto.createHash('sha256').update(rawGuestToken).digest('hex');
      }

      // 4. Atomically create confirmed Reservation
      const reservation = await tx.reservation.create({
        data: {
          tableId: hold.tableId,
          userId: userId || null,
          customerName: guestDetails.customerName,
          customerEmail: guestDetails.customerEmail,
          customerPhone: guestDetails.customerPhone,
          guestCount: guestDetails.guestCount,
          guestAccessTokenHash: guestAccessTokenHash || null,
          startTime: hold.slotStartTime,
          endTime: hold.slotEndTime,
          status: ReservationStatus.CONFIRMED,
        },
        include: {
          table: true,
        },
      });

      // 5. Atomically release/delete the hold record
      await tx.reservationHold.delete({
        where: { id: hold.id },
      });

      return {
        ...reservation,
        ...(rawGuestToken ? { guestAccessToken: rawGuestToken } : {}),
      };
    });
  }

  // ----------------------------------------------------
  // CANCEL RESERVATION
  // ----------------------------------------------------

  async cancelReservation(
    reservationId: string,
    actor: { id?: string; role: Role },
    guestToken?: string
  ) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) {
      const err: any = new Error('Reservation not found');
      err.statusCode = 404;
      err.code = 'RESERVATION_NOT_FOUND';
      throw err;
    }

    // Access control:
    if (actor.role === Role.CUSTOMER) {
      if (reservation.userId) {
        if (reservation.userId !== actor.id) {
          const err: any = new Error('Cannot cancel another customer reservation');
          err.statusCode = 403;
          err.code = 'FORBIDDEN_RESERVATION_ACCESS';
          throw err;
        }
      } else {
        // Guest reservation: MUST supply matching guest access token
        if (reservation.guestAccessTokenHash) {
          if (!guestToken) {
            const err: any = new Error(
              'Guest reservations require a valid guest access token to cancel'
            );
            err.statusCode = 403;
            err.code = 'FORBIDDEN_RESERVATION_ACCESS';
            throw err;
          }

          const computedHash = crypto.createHash('sha256').update(guestToken).digest('hex');
          const expectedBuffer = Buffer.from(reservation.guestAccessTokenHash, 'utf8');
          const actualBuffer = Buffer.from(computedHash, 'utf8');

          if (
            expectedBuffer.length !== actualBuffer.length ||
            !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
          ) {
            const err: any = new Error('Invalid guest access token');
            err.statusCode = 403;
            err.code = 'FORBIDDEN_RESERVATION_ACCESS';
            throw err;
          }
        }
      }
    }

    if (reservation.status === ReservationStatus.CANCELLED) {
      const err: any = new Error('Reservation is already cancelled');
      err.statusCode = 400;
      err.code = 'ALREADY_CANCELLED';
      throw err;
    }

    return this.prisma.reservation.update({
      where: { id: reservationId },
      data: { status: ReservationStatus.CANCELLED },
      include: { table: true },
    });
  }

  async getCustomerReservations(userId: string) {
    return this.prisma.reservation.findMany({
      where: { userId },
      orderBy: { startTime: 'desc' },
      include: { table: true },
    });
  }

  // ----------------------------------------------------
  // ADMIN & STAFF MANAGEMENT APIS
  // ----------------------------------------------------

  async getAllReservations(filters?: { date?: string; status?: ReservationStatus }) {
    const where: any = {};
    if (filters?.status) {
      where.status = filters.status;
    }
    if (filters?.date) {
      const dayStart = new Date(`${filters.date}T00:00:00.000Z`);
      const dayEnd = new Date(`${filters.date}T23:59:59.999Z`);
      where.startTime = { gte: dayStart, lte: dayEnd };
    }

    return this.prisma.reservation.findMany({
      where,
      orderBy: { startTime: 'asc' },
      include: {
        table: true,
      },
    });
  }
}
