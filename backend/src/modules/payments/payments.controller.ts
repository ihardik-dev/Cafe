import { FastifyReply, FastifyRequest } from 'fastify';
import { PaymentsService } from './payments.service.js';
import { createPaymentIntentSchema, manualRefundSchema } from './payments.schema.js';

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
      const intent = await this.paymentsService.createPaymentIntent(parseResult.data.orderId, userId);
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

  async handleWebhook(request: FastifyRequest, reply: FastifyReply) {
    const signature = request.headers['x-webhook-signature'] as string | undefined;

    // Use rawBody string or stringified body
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
