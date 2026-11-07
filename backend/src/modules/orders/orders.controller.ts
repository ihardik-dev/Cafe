import { FastifyReply, FastifyRequest } from 'fastify';
import { OrdersService } from './orders.service.js';
import { checkoutRequestSchema, updateOrderStatusSchema } from './orders.schema.js';
import { Role } from '@prisma/client';

export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  async checkout(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = checkoutRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const userId = request.user?.id || (request.user as any)?.userId;
      const guestSessionId = (request.headers['x-guest-session-id'] as string) || parseResult.data.guestSessionId;
      const result = await this.ordersService.checkout(parseResult.data, userId, guestSessionId);
      return reply.status(result.isDuplicateSubmission ? 200 : 201).send(result);
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async getOrderById(request: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) {
    try {
      const actor = request.user ? { id: request.user.id, role: request.user.role } : { role: Role.CUSTOMER };
      const guestToken = request.headers['x-guest-access-token'] as string | undefined;
      const order = await this.ordersService.getOrderById(request.params.orderId, actor, guestToken);
      return reply.status(200).send({ order });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async updateOrderStatus(
    request: FastifyRequest<{ Params: { orderId: string } }>,
    reply: FastifyReply
  ) {
    const parseResult = updateOrderStatusSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const actor = request.user
        ? { id: request.user.id, role: request.user.role }
        : { role: Role.CUSTOMER };
      const guestToken = request.headers['x-guest-access-token'] as string | undefined;

      const order = await this.ordersService.updateOrderStatus(
        request.params.orderId,
        parseResult.data,
        actor,
        guestToken
      );
      return reply.status(200).send({ order });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async getMyOrders(request: FastifyRequest, reply: FastifyReply) {
    try {
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Must be logged in to view my orders',
        });
      }

      const orders = await this.ordersService.getCustomerOrders(request.user.id);
      return reply.status(200).send({ orders });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async getAllOrders(request: FastifyRequest<{ Querystring: { status?: any; limit?: number; offset?: number } }>, reply: FastifyReply) {
    try {
      const result = await this.ordersService.getAllOrders(request.query);
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
}
