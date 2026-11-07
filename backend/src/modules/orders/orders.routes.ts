import { FastifyPluginAsync } from 'fastify';
import { Role } from '@prisma/client';
import { MenuService } from '../menu/menu.service.js';
import { OrdersService } from './orders.service.js';
import { OrdersController } from './orders.controller.js';

export const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  const menuService = new MenuService(fastify.prisma);
  const ordersService = new OrdersService(fastify.prisma, menuService);
  const controller = new OrdersController(ordersService);

  // POST /checkout (Guest or Authenticated Customer)
  fastify.post(
    '/checkout',
    {
      preHandler: [fastify.optionalAuthenticate],
      schema: {
        tags: ['Orders'],
        summary: 'Place and checkout an order (calculates prices & reserves inventory atomically)',
        body: {
          type: 'object',
          required: ['idempotencyKey', 'items'],
          properties: {
            idempotencyKey: { type: 'string', minLength: 8 },
            customerEmail: { type: 'string', format: 'email' },
            customerPhone: { type: 'string' },
            customerNote: { type: 'string' },
            items: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['menuItemId', 'quantity'],
                properties: {
                  menuItemId: { type: 'string' },
                  quantity: { type: 'integer', minimum: 1, maximum: 100 },
                  selectedModifierOptionIds: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    controller.checkout.bind(controller)
  );

  // GET / (Staff & Admin order management listing)
  fastify.get(
    '/',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.STAFF, Role.ADMIN])],
      schema: {
        tags: ['Orders'],
        summary: 'List all cafe orders with status filters and pagination (Staff/Admin)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            limit: { type: 'integer', default: 50 },
            offset: { type: 'integer', default: 0 },
          },
        },
      },
    },
    controller.getAllOrders.bind(controller) as any
  );

  // GET /my-orders (Authenticated Customer)
  fastify.get(
    '/my-orders',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['Orders'],
        summary: 'View order history for authenticated customer',
        security: [{ bearerAuth: [] }],
      },
    },
    controller.getMyOrders.bind(controller)
  );

  // GET /:orderId (Customer or Staff)
  fastify.get(
    '/:orderId',
    {
      preHandler: [fastify.optionalAuthenticate],
      schema: {
        tags: ['Orders'],
        summary: 'Get order details, items, pricing breakdown, and status history',
        headers: {
          type: 'object',
          properties: {
            'x-guest-access-token': {
              type: 'string',
              description: 'Guest Access Token (required for unauthenticated orders)',
            },
          },
        },
        params: {
          type: 'object',
          required: ['orderId'],
          properties: { orderId: { type: 'string' } },
        },
      },
    },
    controller.getOrderById.bind(controller) as any
  );

  // PATCH /:orderId/status (State Machine Transition)
  fastify.patch(
    '/:orderId/status',
    {
      preHandler: [fastify.optionalAuthenticate],
      schema: {
        tags: ['Orders'],
        summary: 'Transition order state (guarded by state machine & RBAC)',
        headers: {
          type: 'object',
          properties: {
            'x-guest-access-token': {
              type: 'string',
              description: 'Guest Access Token (required for guest order cancellation)',
            },
          },
        },
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['orderId'],
          properties: { orderId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: [
                'CONFIRMED',
                'PREPARING',
                'READY_FOR_PICKUP',
                'COMPLETED',
                'CANCELLED',
                'REFUNDED',
              ],
            },
            reason: { type: 'string' },
          },
        },
      },
    },
    controller.updateOrderStatus.bind(controller) as any
  );
};
