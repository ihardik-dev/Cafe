import { describe, it, expect } from 'vitest';
import {
  priceInCentsSchema,
  positiveQuantitySchema,
  createMenuItemSchema,
  createModifierGroupSchema,
  createModifierOptionSchema,
} from '../src/modules/menu/menu.schema.js';
import { Prisma } from '@prisma/client';

describe('STEP 1 ADVERSARIAL BREAK TESTS: Schema, Types & Financial Integrity', () => {
  describe('Adversarial Financial Integrity: priceInCentsSchema', () => {
    it('MUST REJECT negative prices (attacker attempting to get paid by the cafe)', () => {
      const negativePrices = [-1, -500, -9999999];
      for (const price of negativePrices) {
        const result = priceInCentsSchema.safeParse(price);
        expect(result.success, `Expected price ${price} to fail`).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.message).toMatch(/cannot be negative/i);
        }
      }
    });

    it('MUST REJECT floating-point prices (preventing IEEE 754 decimal rounding bugs)', () => {
      const floatPrices = [4.99, 0.01, 12.3456, 9.999999];
      for (const price of floatPrices) {
        const result = priceInCentsSchema.safeParse(price);
        expect(result.success, `Expected float ${price} to fail`).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.message).toMatch(/integer/i);
        }
      }
    });

    it('MUST REJECT non-number poisonous values: NaN, Infinity, -Infinity, strings, null', () => {
      const toxicValues = [NaN, Infinity, -Infinity, '450', null, undefined, {}, []];
      for (const val of toxicValues) {
        const result = priceInCentsSchema.safeParse(val);
        expect(result.success, `Expected toxic value ${val} to fail`).toBe(false);
      }
    });

    it('MUST ACCEPT valid integer cents (0 for free items, positive ints for paid)', () => {
      expect(priceInCentsSchema.safeParse(0).success).toBe(true);
      expect(priceInCentsSchema.safeParse(450).success).toBe(true);
      expect(priceInCentsSchema.safeParse(1250).success).toBe(true);
    });
  });

  describe('Adversarial Inventory & Quantity Abuse: positiveQuantitySchema', () => {
    it('MUST REJECT quantity of 0 (empty order item attack)', () => {
      const result = positiveQuantitySchema.safeParse(0);
      expect(result.success).toBe(false);
    });

    it('MUST REJECT negative quantities (reverse-inventory attack to fake item stock)', () => {
      const toxicQuantities = [-1, -10, -999];
      for (const qty of toxicQuantities) {
        const result = positiveQuantitySchema.safeParse(qty);
        expect(result.success).toBe(false);
      }
    });

    it('MUST REJECT absurd quantities > 100 (preventing integer overflow in total bill calculation)', () => {
      const overflows = [101, 1000, 2147483647];
      for (const qty of overflows) {
        const result = positiveQuantitySchema.safeParse(qty);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.message).toMatch(/maximum 100/i);
        }
      }
    });

    it('MUST REJECT fractional quantities (e.g. customer asking for 1.5 croissants)', () => {
      expect(positiveQuantitySchema.safeParse(1.5).success).toBe(false);
      expect(positiveQuantitySchema.safeParse(0.5).success).toBe(false);
    });
  });

  describe('Adversarial Modifier Group Attacks', () => {
    it('MUST REJECT impossible selection rules where minSelection > maxSelection', () => {
      const brokenGroup = {
        menuItemId: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Toxic Group',
        minSelection: 3,
        maxSelection: 1, // Impossible: must pick 3 but can pick at most 1!
      };
      const result = createModifierGroupSchema.safeParse(brokenGroup);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/greater than or equal/i);
      }
    });

    it('MUST REJECT negative minSelection', () => {
      const negativeMin = {
        menuItemId: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Negative Min Group',
        minSelection: -1,
        maxSelection: 2,
      };
      expect(createModifierGroupSchema.safeParse(negativeMin).success).toBe(false);
    });

    it('MUST REJECT modifier option with negative extra price (discount hijacking)', () => {
      const negativeModifier = {
        groupId: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Malicious Discount Surcharge',
        extraPriceInCents: -200, // Attacker trying to knock $2 off the total bill
      };
      const result = createModifierOptionSchema.safeParse(negativeModifier);
      expect(result.success).toBe(false);
    });
  });

  describe('Prisma Client Model & Type Metadata Verification', () => {
    it('MUST have all required models exposed in Prisma DMMF', () => {
      const dmmf = Prisma.dmmf;
      const modelNames = dmmf.datamodel.models.map((m) => m.name);

      const requiredModels = [
        'User',
        'Category',
        'MenuItem',
        'ModifierGroup',
        'ModifierOption',
        'InventoryItem',
        'Order',
        'OrderItem',
        'OrderItemModifier',
        'OrderStatusHistory',
        'Table',
        'Reservation',
        'ReservationHold',
        'InboundWebhookEvent',
        'RefundAudit',
      ];

      for (const model of requiredModels) {
        expect(modelNames, `Missing model ${model} in Prisma schema`).toContain(model);
      }
    });

    it('MUST have compound unique constraint on ReservationHold [tableId, slotStartTime]', () => {
      const dmmf = Prisma.dmmf;
      const holdModel = dmmf.datamodel.models.find((m) => m.name === 'ReservationHold');
      expect(holdModel).toBeDefined();

      const uniqueFields = holdModel?.uniqueFields || [];
      const hasCompoundSlotLock = uniqueFields.some(
        (fields) => fields.includes('tableId') && fields.includes('slotStartTime')
      );
      expect(hasCompoundSlotLock, 'ReservationHold MUST have compound unique constraint on tableId and slotStartTime').toBe(true);
    });

    it('MUST have unique constraint on InboundWebhookEvent.eventId for idempotency', () => {
      const dmmf = Prisma.dmmf;
      const eventModel = dmmf.datamodel.models.find((m) => m.name === 'InboundWebhookEvent');
      expect(eventModel).toBeDefined();

      const eventIdField = eventModel?.fields.find((f) => f.name === 'eventId');
      expect(eventIdField?.isUnique, 'InboundWebhookEvent.eventId MUST be unique to prevent replay attacks').toBe(true);
    });
  });

  describe('Adversarial Checkout & Order Invariants', () => {
    it('MUST REJECT empty cart checkout (empty items array)', async () => {
      const { checkoutRequestSchema } = await import('../src/modules/orders/orders.schema.js');
      const emptyOrder = {
        idempotencyKey: 'test-idemp-key-12345',
        items: [],
      };
      const result = checkoutRequestSchema.safeParse(emptyOrder);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/at least 1 item/i);
      }
    });

    it('MUST IGNORE client-injected pricing fields (prevents price spoofing)', async () => {
      const { checkoutRequestSchema } = await import('../src/modules/orders/orders.schema.js');
      const spoofedOrder = {
        idempotencyKey: 'test-idemp-key-12345',
        items: [
          {
            menuItemId: '123e4567-e89b-12d3-a456-426614174000',
            quantity: 2,
            selectedModifierOptionIds: [],
            priceInCents: 0, // Attacker trying to say price is $0.00!
            totalInCents: 0,
          },
        ],
        totalInCents: 0, // Attacker spoofing bill total!
      };
      const parsed = checkoutRequestSchema.parse(spoofedOrder);
      // Ensure the spoofed totalInCents is NOT part of the validated object
      expect((parsed as any).totalInCents).toBeUndefined();
      expect((parsed.items[0] as any).priceInCents).toBeUndefined();
    });

    it('MUST REJECT cart with more than 30 unique items (denial-of-service prevention)', async () => {
      const { checkoutRequestSchema } = await import('../src/modules/orders/orders.schema.js');
      const oversizedCart = {
        idempotencyKey: 'test-idemp-key-12345',
        items: Array.from({ length: 31 }, () => ({
          menuItemId: '123e4567-e89b-12d3-a456-426614174000',
          quantity: 1,
          selectedModifierOptionIds: [],
        })),
      };
      const result = checkoutRequestSchema.safeParse(oversizedCart);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/cannot exceed 30/i);
      }
    });
  });

  describe('Adversarial Reservation Booking Attacks', () => {
    it('MUST REJECT reservations in the past', async () => {
      const { holdReservationSchema } = await import('../src/modules/reservations/reservations.schema.js');
      const pastTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      const attackBooking = {
        tableId: '123e4567-e89b-12d3-a456-426614174000',
        guestCount: 2,
        startTime: pastTime,
        durationMinutes: 60,
        customerName: 'Past Booker',
        customerEmail: 'past@example.com',
        customerPhone: '+1234567890',
      };
      const result = holdReservationSchema.safeParse(attackBooking);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/cannot be in the past/i);
      }
    });

    it('MUST REJECT impossible guest counts: 0, negative, or > 20', async () => {
      const { holdReservationSchema } = await import('../src/modules/reservations/reservations.schema.js');
      const futureTime = new Date(Date.now() + 86400000).toISOString(); // Tomorrow
      const invalidGuests = [0, -1, 21, 100];
      for (const guests of invalidGuests) {
        const payload = {
          tableId: '123e4567-e89b-12d3-a456-426614174000',
          guestCount: guests,
          startTime: futureTime,
          durationMinutes: 60,
          customerName: 'Guest Count Attacker',
          customerEmail: 'attacker@example.com',
          customerPhone: '+1234567890',
        };
        const result = holdReservationSchema.safeParse(payload);
        expect(result.success, `Expected guestCount ${guests} to fail`).toBe(false);
      }
    });

    it('MUST REJECT non-standard slot durations (e.g. 17 minutes or 75 minutes)', async () => {
      const { holdReservationSchema } = await import('../src/modules/reservations/reservations.schema.js');
      const futureTime = new Date(Date.now() + 86400000).toISOString();
      const payload = {
        tableId: '123e4567-e89b-12d3-a456-426614174000',
        guestCount: 2,
        startTime: futureTime,
        durationMinutes: 45, // Not 60, 90, or 120
        customerName: 'Duration Attacker',
        customerEmail: 'attacker@example.com',
        customerPhone: '+1234567890',
      };
      const result = holdReservationSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/either 60, 90, or 120/i);
      }
    });
  });
});
