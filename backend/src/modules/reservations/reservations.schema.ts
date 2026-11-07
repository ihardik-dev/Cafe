import { z } from 'zod';

export const holdReservationSchema = z
  .object({
    tableId: z.string().min(1, 'Table ID is required'),
    guestCount: z
      .number({ error: 'Guest count must be a number' })
      .int('Guest count must be an integer')
      .min(1, 'At least 1 guest required')
      .max(20, 'For groups larger than 20, please contact cafe management directly'),
    startTime: z.string().datetime({ message: 'Start time must be a valid ISO 8601 UTC string' }),
    durationMinutes: z
      .number()
      .int()
      .refine((val) => [60, 90, 120].includes(val), {
        message: 'Reservation duration must be either 60, 90, or 120 minutes',
      })
      .default(60),
    customerName: z.string().min(2, 'Name must be at least 2 characters').max(100).trim(),
    customerEmail: z.string().email('Invalid email address').toLowerCase().trim(),
    customerPhone: z.string().min(7, 'Invalid phone number').max(20).trim(),
  })
  .refine(
    (data) => {
      const start = new Date(data.startTime).getTime();
      const now = Date.now();
      // Cannot book in the past (allow 60s tolerance for network latency)
      return start > now - 60000;
    },
    {
      message: 'Reservation start time cannot be in the past',
      path: ['startTime'],
    }
  );

export const confirmReservationSchema = z.object({
  holdToken: z.string().min(10, 'Invalid hold token format'),
});

export const getAvailableSlotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  guests: z.coerce.number().int().min(1).max(20).default(2),
});

export type HoldReservationInput = z.infer<typeof holdReservationSchema>;
export type ConfirmReservationInput = z.infer<typeof confirmReservationSchema>;
export type GetAvailableSlotsQuery = z.infer<typeof getAvailableSlotsQuerySchema>;
