import { FastifyPluginAsync } from 'fastify';
import { Role } from '@prisma/client';
import { ReservationsService } from './reservations.service.js';
import { ReservationsController } from './reservations.controller.js';

export const reservationsRoutes: FastifyPluginAsync = async (fastify) => {
  const reservationsService = new ReservationsService(fastify.prisma);
  const controller = new ReservationsController(reservationsService);

  // GET /tables (Public)
  fastify.get(
    '/tables',
    {
      schema: {
        tags: ['Reservations'],
        summary: 'List all cafe tables with capacities and dining areas',
      },
    },
    controller.getTables.bind(controller)
  );

  // GET /available-slots (Public)
  fastify.get(
    '/available-slots',
    {
      schema: {
        tags: ['Reservations'],
        summary: 'Find available table slots for a specific date and guest count',
        querystring: {
          type: 'object',
          required: ['date'],
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            guests: { type: 'integer', default: 2 },
          },
        },
      },
    },
    controller.getAvailableSlots.bind(controller)
  );

  // POST /hold (Public or Authenticated Customer)
  fastify.post(
    '/hold',
    {
      preHandler: [fastify.optionalAuthenticate],
      schema: {
        tags: ['Reservations'],
        summary: 'Place a 10-minute temporary lock on a slot (concurrency safe)',
        body: {
          type: 'object',
          required: ['tableId', 'startTime', 'customerName', 'customerEmail', 'customerPhone', 'guestCount'],
          properties: {
            tableId: { type: 'string' },
            startTime: { type: 'string', format: 'date-time' },
            durationMinutes: { type: 'integer', enum: [60, 90, 120], default: 60 },
            customerName: { type: 'string', minLength: 2 },
            customerEmail: { type: 'string', format: 'email' },
            customerPhone: { type: 'string' },
            guestCount: { type: 'integer', minimum: 1, maximum: 20 },
          },
        },
      },
    },
    controller.holdSlot.bind(controller)
  );

  // POST /confirm (Public or Authenticated Customer)
  fastify.post(
    '/confirm',
    {
      preHandler: [fastify.optionalAuthenticate],
      schema: {
        tags: ['Reservations'],
        summary: 'Finalize reservation using unexpired hold token',
        body: {
          type: 'object',
          required: ['holdToken', 'customerName', 'customerEmail', 'customerPhone', 'guestCount'],
          properties: {
            holdToken: { type: 'string', minLength: 10 },
            customerName: { type: 'string' },
            customerEmail: { type: 'string', format: 'email' },
            customerPhone: { type: 'string' },
            guestCount: { type: 'integer' },
          },
        },
      },
    },
    controller.confirmReservation.bind(controller)
  );

  // GET / (Staff & Admin list all reservations schedule)
  fastify.get(
    '/',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.STAFF, Role.ADMIN])],
      schema: {
        tags: ['Reservations'],
        summary: 'List all reservations schedule with date & status filters (Staff/Admin)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            status: { type: 'string' },
          },
        },
      },
    },
    controller.getAllReservations.bind(controller) as any
  );

  // GET /my-bookings (Authenticated Customer)
  fastify.get(
    '/my-bookings',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['Reservations'],
        summary: 'View reservation bookings for authenticated customer',
        security: [{ bearerAuth: [] }],
      },
    },
    controller.getMyReservations.bind(controller)
  );

  // PATCH /:id/cancel (Customer, Staff, or Admin)
  fastify.patch(
    '/:id/cancel',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['Reservations'],
        summary: 'Cancel a reservation booking',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    controller.cancelReservation.bind(controller) as any
  );
};
