import { z } from 'zod';

/**
 * Currency values (INR) must ALWAYS be:
 * 1. Integers (never floats like 240.50)
 * 2. Non-negative (>= 0)
 * 3. In Indian paise (e.g. ₹240.00 -> 24000 paise; ₹1 = 100 paise)
 */
export const priceInPaiseSchema = z
  .number({
    error: 'Price in paise is required and must be an integer number',
  })
  .int('Price must be an integer (in paise), never a decimal/float')
  .min(0, 'Price in paise cannot be negative');

export const positiveQuantitySchema = z
  .number({
    error: 'Quantity is required and must be a number',
  })
  .int('Quantity must be an integer')
  .min(1, 'Quantity must be at least 1')
  .max(100, 'Maximum 100 items per line to prevent inventory exhaustion abuse');

// Create Menu Item Request Validator
export const createMenuItemSchema = z.object({
  categoryId: z.string().uuid('Invalid category ID'),
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  description: z.string().max(500).optional(),
  priceInPaise: priceInPaiseSchema,
  imageUrl: z.string().url().optional(),
  isAvailable: z.boolean().default(true),
  isPerishable: z.boolean().default(false),
});

// Create Modifier Group Request Validator
export const createModifierGroupSchema = z.object({
  menuItemId: z.string().uuid('Invalid menu item ID'),
  name: z.string().min(2).max(100),
  minSelection: z.number().int().min(0).default(0),
  maxSelection: z.number().int().min(1).default(1),
}).refine((data) => data.maxSelection >= data.minSelection, {
  message: 'maxSelection must be greater than or equal to minSelection',
  path: ['maxSelection'],
});

// Create Modifier Option Request Validator
export const createModifierOptionSchema = z.object({
  groupId: z.string().uuid('Invalid modifier group ID'),
  name: z.string().min(1).max(100),
  extraPriceInPaise: priceInPaiseSchema,
  isAvailable: z.boolean().default(true),
});

export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type CreateModifierGroupInput = z.infer<typeof createModifierGroupSchema>;
export type CreateModifierOptionInput = z.infer<typeof createModifierOptionSchema>;
