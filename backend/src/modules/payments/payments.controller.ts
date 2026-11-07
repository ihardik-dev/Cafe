import { FastifyReply, FastifyRequest } from 'fastify';
import { PaymentsService } from './payments.service.js';
import {
  createPaymentIntentSchema,
  verifyPaymentSchema,
  manualRefundSchema,
} from './payments.schema.js';

export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  async createPaymentIntent(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = createPaymentIntentSchema.safeParse(request.body);
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
      const guestToken = request.headers['x-guest-access-token'] as string | undefined;
      const intent = await this.paymentsService.createPaymentIntent(
        parseResult.data.orderId,
        userId,
        guestToken
      );
      return reply.status(200).send({ paymentIntent: intent });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async verifyPayment(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = verifyPaymentSchema.safeParse(request.body);
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
      const guestToken =
        (request.headers['x-guest-access-token'] as string) ||
        parseResult.data.guestAccessToken;
      const result = await this.paymentsService.verifyPayment(
        parseResult.data,
        userId,
        guestToken
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

  async handleWebhook(request: FastifyRequest, reply: FastifyReply) {
    // Support both Razorpay's native header and custom webhook header
    const signature =
      (request.headers['x-razorpay-signature'] as string | undefined) ||
      (request.headers['x-webhook-signature'] as string | undefined);

    const rawBody = (request as any).rawBody || JSON.stringify(request.body);

    try {
      const result = await this.paymentsService.processWebhook(rawBody, signature);
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

  async issueManualRefund(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = manualRefundSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const adminId = request.user?.id || 'ADMIN';
      const result = await this.paymentsService.issueManualRefund(
        parseResult.data.orderId,
        parseResult.data.reason,
        adminId
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
}
