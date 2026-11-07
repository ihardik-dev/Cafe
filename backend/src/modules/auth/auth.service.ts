import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { FastifyInstance } from 'fastify';
import { RegisterInput, LoginInput, AuthResponse, SafeUser } from './auth.schema.js';
import { env } from '../../config/env.js';

export class AuthService {
  constructor(
    private prisma: PrismaClient,
    private fastify: FastifyInstance
  ) {}

  private sanitizeUser(user: {
    id: string;
    email: string;
    name: string;
    role: Role;
    createdAt: Date;
  }): SafeUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async register(input: RegisterInput): Promise<AuthResponse> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: input.email },
    });

    if (existingUser) {
      const error: any = new Error('An account with this email address already exists');
      error.statusCode = 409;
      error.code = 'EMAIL_ALREADY_EXISTS';
      throw error;
    }

    const passwordHash = await bcrypt.hash(input.password, 10);

    // Hardened RBAC: Public signups are ALWAYS created with CUSTOMER role
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        role: Role.CUSTOMER,
      },
    });

    const tokens = await this.generateTokenPair(user);
    return {
      user: this.sanitizeUser(user),
      tokens,
    };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
    });

    if (!user) {
      const error: any = new Error('Invalid email or password');
      error.statusCode = 401;
      error.code = 'INVALID_CREDENTIALS';
      throw error;
    }

    const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!isPasswordValid) {
      const error: any = new Error('Invalid email or password');
      error.statusCode = 401;
      error.code = 'INVALID_CREDENTIALS';
      throw error;
    }

    const tokens = await this.generateTokenPair(user);
    return {
      user: this.sanitizeUser(user),
      tokens,
    };
  }

  async refreshToken(rawRefreshToken: string): Promise<AuthResponse> {
    let payload: any;
    try {
      // Use dedicated JWT_REFRESH_SECRET to separate access and refresh token signing keys
      payload = jwt.verify(rawRefreshToken, env.JWT_REFRESH_SECRET);
    } catch {
      const error: any = new Error('Invalid or expired refresh token');
      error.statusCode = 401;
      error.code = 'INVALID_REFRESH_TOKEN';
      throw error;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.id },
    });

    if (!user || !user.refreshToken) {
      const error: any = new Error('Session has expired or been revoked');
      error.statusCode = 401;
      error.code = 'SESSION_REVOKED';
      throw error;
    }

    // Anti-Replay Defense: Refresh tokens are hashed via SHA-256 before bcrypt comparison
    // to strictly prevent bcrypt's 72-byte truncation vulnerability on long JWT strings!
    const tokenDigest = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const isTokenMatch = await bcrypt.compare(tokenDigest, user.refreshToken);
    if (!isTokenMatch) {
      // Possible token theft or replay attack: revoke session immediately!
      await this.prisma.user.update({
        where: { id: user.id },
        data: { refreshToken: null },
      });

      const error: any = new Error('Refresh token reuse detected. All sessions revoked for security.');
      error.statusCode = 401;
      error.code = 'REFRESH_TOKEN_REUSED';
      throw error;
    }

    // Rotate token pair
    const tokens = await this.generateTokenPair(user);
    return {
      user: this.sanitizeUser(user),
      tokens,
    };
  }

  async getProfile(userId: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      const error: any = new Error('User not found');
      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';
      throw error;
    }

    return this.sanitizeUser(user);
  }

  private async generateTokenPair(user: { id: string; email: string; role: Role }) {
    const accessToken = this.fastify.jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    const refreshToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        jti: crypto.randomUUID(), // Guarantee cryptographic uniqueness on every rotation
      },
      env.JWT_REFRESH_SECRET,
      { expiresIn: env.JWT_REFRESH_EXPIRES_IN as any }
    );

    // Pre-hash with SHA-256 before bcrypt to prevent bcrypt 72-byte truncation on long JWTs
    const tokenDigest = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const hashedRefreshToken = await bcrypt.hash(tokenDigest, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: hashedRefreshToken },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: env.JWT_EXPIRES_IN,
    };
  }
}
