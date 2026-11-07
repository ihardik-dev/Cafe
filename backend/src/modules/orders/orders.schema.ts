import { z } from 'zod';
import { positiveQuantitySchema } from '../menu/menu.schema.js';

export const checkoutItemSchema = z.object({
  menuItemId: z.string().uuid('Invalid menu item ID'),
  quantity: positiveQuantitySchema,
  selectedModifierOptionIds: z.array(z.string().uuid('Invalid modifier option ID')).default([]),
});

export const checkoutRequestSchema = z.object({
  idempotencyKey: z
    .string()
    .min(10, 'Idempotency key must be at least 10 characters')
    .max(128, 'Idempotency key too long'),
  items: z
    .array(checkoutItemSchema)
    .min(1, 'Order must contain at least 1 item')
    .max(30, 'Cart cannot exceed 30 unique items'),
  customerEmail: z.string().email('Invalid customer email').optional(),
  customerPhone: z.string().min(7).max(20).optional(),
  customerNote: z.string().max(250, 'Customer note cannot exceed 250 characters').optional(),
});

export type CheckoutRequestInput = z.infer<typeof checkoutRequestSchema>;
export type CheckoutItemInput = z.infer<typeof checkoutItemSchema>;
