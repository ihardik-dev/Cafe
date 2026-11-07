import { FastifyReply, FastifyRequest } from 'fastify';
import { ReservationsService } from './reservations.service.js';
import {
  holdReservationSchema,
  getAvailableSlotsQuerySchema,
} from './reservations.schema.js';
import { Role } from '@prisma/client';
import { z } from 'zod';

const confirmWithDetailsSchema = z.object({
  holdToken: z.string().min(10, 'Hold token is required'),
  customerName: z.string().min(2).max(100).trim(),
  customerEmail: z.string().email().toLowerCase().trim(),
  customerPhone: z.string().min(7).max(20).trim(),
  guestCount: z.number().int().min(1).max(20),
});

export class ReservationsController {
  constructor(private reservationsService: ReservationsService) {}

  async getTables(_request: FastifyRequest, reply: FastifyReply) {
    const tables = await this.reservationsService.getTables();
    return reply.status(200).send({ tables });
  }

  async getAvailableSlots(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = getAvailableSlotsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const result = await this.reservationsService.getAvailableSlots(
        parseResult.data.date,
        parseResult.data.guests
      );
      return reply.status(200).send(result);
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async holdSlot(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = holdReservationSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const userId = request.user?.id;
      const result = await this.reservationsService.holdSlot(parseResult.data, userId);
      return reply.status(201).send(result);
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async confirmReservation(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = confirmWithDetailsSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const userId = request.user?.id;
      const reservation = await this.reservationsService.confirmReservation(
        { holdToken: parseResult.data.holdToken },
        {
          customerName: parseResult.data.customerName,
          customerEmail: parseResult.data.customerEmail,
          customerPhone: parseResult.data.customerPhone,
          guestCount: parseResult.data.guestCount,
        },
        userId
      );
      return reply.status(201).send({ reservation });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async cancelReservation(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) {
    try {
      const actor = request.user
        ? { id: request.user.id, role: request.user.role }
        : { role: Role.CUSTOMER };

      const guestToken = request.headers['x-guest-access-token'] as string | undefined;
      const reservation = await this.reservationsService.cancelReservation(
        request.params.id,
        actor,
        guestToken
      );
      return reply.status(200).send({ reservation });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async getMyReservations(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication required to view your reservations',
      });
    }

    try {
      const reservations = await this.reservationsService.getCustomerReservations(
        request.user.id
      );
      return reply.status(200).send({ reservations });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async getAllReservations(
    request: FastifyRequest<{ Querystring: { date?: string; status?: any } }>,
    reply: FastifyReply
  ) {
    try {
      const reservations = await this.reservationsService.getAllReservations(request.query);
      return reply.status(200).send({ reservations });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }
}
