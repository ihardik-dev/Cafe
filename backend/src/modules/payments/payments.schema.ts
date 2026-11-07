import { z } from 'zod';

export const createPaymentIntentSchema = z.object({
  orderId: z.string().min(1, 'Order ID is required'),
});

export const verifyPaymentSchema = z.object({
  orderId: z.string().optional(),
  razorpayOrderId: z.string().min(1, 'razorpayOrderId is required'),
  razorpayPaymentId: z.string().min(1, 'razorpayPaymentId is required'),
  razorpaySignature: z.string().min(1, 'razorpaySignature is required'),
  guestAccessToken: z.string().optional(),
});

export const webhookPayloadSchema = z.object({
  eventId: z.string().min(1, 'Webhook event ID is required'),
  eventType: z.enum([
    'payment.captured',
    'payment.failed',
    'order.paid',
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'refund.processed',
  ]),
  data: z.object({
    orderId: z.string().min(1),
    paymentIntentId: z.string().min(1),
    amountInPaise: z.number().int().positive(),
    currency: z.literal('INR').default('INR'),
  }),
});

export const manualRefundSchema = z.object({
  orderId: z.string().min(1, 'Order ID is required'),
  reason: z.string().min(3, 'Refund reason is required').max(200),
});

export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;
export type WebhookPayloadInput = z.infer<typeof webhookPayloadSchema>;
export type ManualRefundInput = z.infer<typeof manualRefundSchema>;
