import { z } from 'zod';
import { Role } from '@prisma/client';

export const registerSchema = z.object({
  email: z
    .string({ error: 'Email is required' })
    .email('Invalid email address')
    .toLowerCase()
    .trim(),
  password: z
    .string({ error: 'Password is required' })
    .min(8, 'Password must be at least 8 characters long')
    .refine((val) => Buffer.byteLength(val, 'utf8') <= 72, {
      message: 'Password exceeds 72-byte cryptographic length limit for bcrypt',
    })
    .regex(/[A-Za-z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  name: z
    .string({ error: 'Name is required' })
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name is too long')
    .trim(),
});

export const loginSchema = z.object({
  email: z
    .string({ error: 'Email is required' })
    .email('Invalid email address')
    .toLowerCase()
    .trim(),
  password: z.string({ error: 'Password is required' }).min(1, 'Password cannot be empty'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string({ error: 'Refresh token is required' }).min(1, 'Refresh token cannot be empty'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: Date;
}

export interface AuthResponse {
  user: SafeUser;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: string;
  };
}
