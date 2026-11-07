import { z } from 'zod';
import { OrderStatus } from '@prisma/client';
import { positiveQuantitySchema } from '../menu/menu.schema.js';

export const checkoutItemSchema = z
  .object({
    menuItemId: z.string().min(1, 'Invalid menu item ID'),
    quantity: positiveQuantitySchema,
    selectedModifierOptionIds: z.array(z.string().min(1, 'Invalid modifier option ID')).default([]),
  })
  .superRefine((data, ctx) => {
    const ids = data.selectedModifierOptionIds || [];
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Duplicate modifier options are not permitted for an item',
        path: ['selectedModifierOptionIds'],
      });
    }
  });

export const checkoutRequestSchema = z.object({
  idempotencyKey: z
    .string()
    .min(8, 'Idempotency key must be at least 8 characters')
    .max(128, 'Idempotency key too long'),
  guestSessionId: z.string().min(1).max(100).optional(),
  items: z
    .array(checkoutItemSchema)
    .min(1, 'Order must contain at least 1 item')
    .max(30, 'Cart cannot exceed 30 unique items'),
  customerEmail: z.string().email('Invalid customer email').optional(),
  customerPhone: z.string().min(7).max(20).optional(),
  customerNote: z.string().max(250, 'Customer note cannot exceed 250 characters').optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.nativeEnum(OrderStatus, {
    message: 'Invalid order status transition target',
  }),
  reason: z.string().max(200).optional(),
});

export type CheckoutRequestInput = z.infer<typeof checkoutRequestSchema>;
export type CheckoutItemInput = z.infer<typeof checkoutItemSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
