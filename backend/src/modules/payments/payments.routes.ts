import { FastifyPluginAsync } from 'fastify';
import { Role } from '@prisma/client';
import { PaymentsService } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';

export const paymentsRoutes: FastifyPluginAsync = async (fastify) => {
  const paymentsService = new PaymentsService(fastify.prisma);
  const controller = new PaymentsController(paymentsService);

  // POST /create-intent (Razorpay Order creation)
  fastify.post(
    '/create-intent',
    {
      preHandler: [fastify.optionalAuthenticate],
      schema: {
        tags: ['Payments'],
        summary: 'Initiate Razorpay payment order for checkout',
        body: {
          type: 'object',
          required: ['orderId'],
          properties: {
            orderId: { type: 'string' },
          },
        },
      },
    },
    controller.createPaymentIntent.bind(controller)
  );

  // POST /verify (Razorpay Client Callback Verification)
  fastify.post(
    '/verify',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Verify Razorpay payment signature from client checkout modal',
        body: {
          type: 'object',
          required: ['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature'],
          properties: {
            orderId: { type: 'string' },
            razorpayOrderId: { type: 'string' },
            razorpayPaymentId: { type: 'string' },
            razorpaySignature: { type: 'string' },
          },
        },
      },
    },
    controller.verifyPayment.bind(controller)
  );

  // POST /webhook (Payment Gateway Webhook Receiver)
  fastify.post(
    '/webhook',
    {
      schema: {
        tags: ['Payments Webhook'],
        summary: 'Payment gateway webhook listener (verifies HMAC and handles late auto-refunds)',
        headers: {
          type: 'object',
          properties: {
            'x-razorpay-signature': { type: 'string' },
            'x-webhook-signature': { type: 'string' },
          },
        },
      },
    },
    controller.handleWebhook.bind(controller)
  );

  // POST /refund (Admin manual refund)
  fastify.post(
    '/refund',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.ADMIN])],
      schema: {
        tags: ['Payments Admin'],
        summary: 'Manually refund an order (Admin only)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['orderId', 'reason'],
          properties: {
            orderId: { type: 'string' },
            reason: { type: 'string', minLength: 3 },
          },
        },
      },
    },
    controller.issueManualRefund.bind(controller)
  );
};
