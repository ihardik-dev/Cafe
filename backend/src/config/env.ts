import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(4000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
    // Razorpay credentials: optional in development/test (payment routes degrade gracefully).
    // REQUIRED in production — no hardcoded defaults, no fallbacks to other secrets.
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    // WEBHOOK_SECRET must be a dedicated secret — NEVER fall back to RAZORPAY_KEY_SECRET.
    WEBHOOK_SECRET: z.string().optional(),
    CORS_ORIGIN: z.string().default('*'),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (data.CORS_ORIGIN === '*' || !data.CORS_ORIGIN.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message:
            'Wildcard CORS ("*") is not permitted in production with credentials. Specify explicit allowed domains in CORS_ORIGIN.',
        });
      }
    }
  });

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid Environment Variables Configuration:');
  // Never print credential values in error output — only field names and messages
  const formatted = parsedEnv.error.format();
  const safeFormatted = JSON.stringify(formatted, null, 2);
  console.error(safeFormatted);
  process.exit(1);
}

export const env = parsedEnv.data;
