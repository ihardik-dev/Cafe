import { PrismaClient, OrderStatus } from '@prisma/client';
import crypto from 'crypto';
import { env } from '../../config/env.js';
import { WebhookPayloadInput, webhookPayloadSchema } from './payments.schema.js';

export class PaymentsService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Cryptographically verifies HMAC-SHA256 signature using timing-safe comparison.
   * Defends against timing attacks and forged webhook injections.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader?: string): boolean {
    if (!signatureHeader) {
      return false;
    }

    const hmac = crypto.createHmac('sha256', env.WEBHOOK_SECRET);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const actualBuffer = Buffer.from(signatureHeader, 'utf8');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  // ----------------------------------------------------
  // PAYMENT INTENT CREATION
  // ----------------------------------------------------

  async createPaymentIntent(orderId: string, requestingUserId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      const err: any = new Error('Order not found');
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    // Access control: Guest orders can be paid, but authenticated orders must match user
    if (order.userId && requestingUserId && order.userId !== requestingUserId) {
      const err: any = new Error('Cannot initiate payment for another customer order');
      err.statusCode = 403;
      err.code = 'FORBIDDEN_ORDER_ACCESS';
      throw err;
    }

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      const err: any = new Error(
        `Cannot initiate payment for order with status ${order.status}. Only PENDING_PAYMENT orders can be paid.`
      );
      err.statusCode = 400;
      err.code = 'ORDER_NOT_PAYABLE';
      throw err;
    }

    if (new Date(order.expiresAt).getTime() <= Date.now()) {
      const err: any = new Error('Order payment window has expired. Please place a new order.');
      err.statusCode = 410;
      err.code = 'ORDER_EXPIRED';
      throw err;
    }

    // Generate unique payment intent token (mock / gateway-compatible)
    const paymentIntentId = order.paymentIntentId || `pi_${crypto.randomBytes(16).toString('hex')}`;

    if (!order.paymentIntentId) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { paymentIntentId },
      });
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentIntentId,
      clientSecret: `${paymentIntentId}_secret_${crypto.randomBytes(8).toString('hex')}`,
      amountInPaise: order.totalInPaise,
      currency: 'INR',
      expiresAt: order.expiresAt,
    };
  }

  // ----------------------------------------------------
  // ROBUST WEBHOOK PROCESSOR & LATE WEBHOOK AUTO-REFUND
  // ----------------------------------------------------

  async processWebhook(rawBody: string, signatureHeader?: string) {
    // 1. HMAC Signature Verification
    const isValidSignature = this.verifyWebhookSignature(rawBody, signatureHeader);
    if (!isValidSignature) {
      const err: any = new Error('Invalid or tampered webhook signature');
      err.statusCode = 401;
      err.code = 'INVALID_WEBHOOK_SIGNATURE';
      throw err;
    }

    // 2. Parse and validate JSON payload
    let parsedJson: any;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      const err: any = new Error('Malformed JSON payload');
      err.statusCode = 400;
      err.code = 'MALFORMED_JSON';
      throw err;
    }

    const parseResult = webhookPayloadSchema.safeParse(parsedJson);
    if (!parseResult.success) {
      const err: any = new Error('Invalid webhook payload structure');
      err.statusCode = 400;
      err.code = 'INVALID_WEBHOOK_PAYLOAD';
      err.details = parseResult.error.format();
      throw err;
    }

    const payload: WebhookPayloadInput = parseResult.data;

    // 3. Webhook Idempotency Check (InboundWebhookEvent)
    const existingEvent = await this.prisma.inboundWebhookEvent.findUnique({
      where: { eventId: payload.eventId },
    });

    if (existingEvent) {
      // Return 200 immediately to gateway; do not duplicate processing!
      return {
        isDuplicate: true,
        eventId: payload.eventId,
        message: 'Webhook event already processed previously (Idempotent OK)',
      };
    }

    // 4. Atomic Execution: Record event + Update Order / Trigger Late Refund
    return this.prisma.$transaction(async (tx) => {
      // Record event for future deduplication
      await tx.inboundWebhookEvent.create({
        data: {
          eventId: payload.eventId,
          eventType: payload.eventType,
          payloadJson: rawBody,
        },
      });

      // Find target order
      const order = await tx.order.findUnique({
        where: { id: payload.data.orderId },
      });

      if (!order) {
        // Order does not exist, acknowledge receipt but log warning
        return {
          isDuplicate: false,
          action: 'ORDER_NOT_FOUND',
          message: `Order ${payload.data.orderId} does not exist in database`,
        };
      }

      // Handle successful payment events
      if (
        payload.eventType === 'payment.captured' ||
        payload.eventType === 'payment_intent.succeeded'
      ) {
        // ----------------------------------------------------
        // CASE A: Standard on-time payment (PENDING_PAYMENT)
        // ----------------------------------------------------
        if (order.status === OrderStatus.PENDING_PAYMENT) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: OrderStatus.CONFIRMED,
              paymentIntentId: payload.data.paymentIntentId,
            },
          });

          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: OrderStatus.CONFIRMED,
              changedBy: 'GATEWAY_WEBHOOK',
              reason: `Payment captured successfully via gateway event: ${payload.eventId}`,
            },
          });

          return {
            isDuplicate: false,
            action: 'ORDER_CONFIRMED',
            orderId: order.id,
            status: OrderStatus.CONFIRMED,
          };
        }

        // ----------------------------------------------------
        // CASE B: THE LATE WEBHOOK SCENARIO (CANCELLED / EXPIRED)
        // Order was cancelled because payment took too long and items were restocked.
        // DO NOT fulfill! Automatically issue refund and audit!
        // ----------------------------------------------------
        if (order.status === OrderStatus.CANCELLED) {
          const gatewayRefundId = `rfnd_${crypto.randomBytes(12).toString('hex')}`;

          // Create audit log for financial reconciliation
          await tx.refundAudit.create({
            data: {
              orderId: order.id,
              paymentIntentId: payload.data.paymentIntentId,
              amountInPaise: payload.data.amountInPaise,
              reason: 'LATE_WEBHOOK_RECEIVED_AFTER_EXPIRATION',
              gatewayRefundId,
              status: 'SUCCEEDED',
            },
          });

          // Transition order to specialized status
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.REFUNDED_LATE_WEBHOOK },
          });

          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: OrderStatus.CANCELLED,
              toStatus: OrderStatus.REFUNDED_LATE_WEBHOOK,
              changedBy: 'SYSTEM_AUTO_REFUND',
              reason: `Late payment webhook received 45m+ after expiration. Automated refund of ₹${payload.data.amountInPaise / 100} initiated (${gatewayRefundId}).`,
            },
          });

          return {
            isDuplicate: false,
            action: 'AUTOMATIC_REFUND_ISSUED',
            orderId: order.id,
            refundAmountInPaise: payload.data.amountInPaise,
            gatewayRefundId,
            status: OrderStatus.REFUNDED_LATE_WEBHOOK,
          };
        }

        // ----------------------------------------------------
        // CASE C: Order already CONFIRMED, PREPARING, or COMPLETED
        // ----------------------------------------------------
        return {
          isDuplicate: false,
          action: 'NO_ACTION_REQUIRED',
          orderId: order.id,
          currentStatus: order.status,
        };
      }

      // Handle payment failure events
      if (
        payload.eventType === 'payment.failed' ||
        payload.eventType === 'payment_intent.payment_failed'
      ) {
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: order.status,
            changedBy: 'GATEWAY_WEBHOOK',
            reason: `Payment attempt failed via gateway event: ${payload.eventId}`,
          },
        });

        return {
          isDuplicate: false,
          action: 'PAYMENT_FAILED_LOGGED',
          orderId: order.id,
        };
      }

      return {
        isDuplicate: false,
        action: 'UNHANDLED_EVENT_TYPE',
        eventType: payload.eventType,
      };
    });
  }

  // ----------------------------------------------------
  // MANUAL REFUND OVERRIDE (ADMIN ONLY)
  // ----------------------------------------------------

  async issueManualRefund(orderId: string, reason: string, adminId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      const err: any = new Error('Order not found');
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    const refundableStatuses: OrderStatus[] = [
      OrderStatus.CONFIRMED,
      OrderStatus.PREPARING,
      OrderStatus.READY_FOR_PICKUP,
    ];

    if (!refundableStatuses.includes(order.status)) {
      const err: any = new Error(
        `Cannot refund order in ${order.status} status. Only confirmed/preparing orders can be refunded.`
      );
      err.statusCode = 400;
      err.code = 'ORDER_NOT_REFUNDABLE';
      throw err;
    }

    const gatewayRefundId = `rfnd_manual_${crypto.randomBytes(12).toString('hex')}`;

    return this.prisma.$transaction(async (tx) => {
      await tx.refundAudit.create({
        data: {
          orderId: order.id,
          paymentIntentId: order.paymentIntentId || 'pi_manual_override',
          amountInPaise: order.totalInPaise,
          reason: `MANUAL_ADMIN_REFUND: ${reason}`,
          gatewayRefundId,
          status: 'SUCCEEDED',
        },
      });

      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUNDED },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: OrderStatus.REFUNDED,
          changedBy: adminId,
          reason: `Manual refund of ₹${order.totalInPaise / 100} issued by Admin: ${reason}`,
        },
      });

      return {
        order: updated,
        refund: {
          gatewayRefundId,
          amountInPaise: order.totalInPaise,
          reason,
        },
      };
    });
  }
}
