import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { buildApp } from '../src/server.js';
import { env } from '../src/config/env.js';

// In-memory test repository simulating Prisma User table
function createInMemoryPrisma() {
  const users: Map<string, any> = new Map();

  return {
    user: {
      async findUnique({ where }: any) {
        if (where.id) {
          return users.get(where.id) || null;
        }
        if (where.email) {
          for (const u of users.values()) {
            if (u.email.toLowerCase() === where.email.toLowerCase()) {
              return { ...u };
            }
          }
          return null;
        }
        return null;
      },
      async create({ data }: any) {
        const id = data.id || `user-${Date.now()}-${Math.random()}`;
        const user = {
          id,
          email: data.email.toLowerCase(),
          passwordHash: data.passwordHash,
          name: data.name,
          role: data.role || Role.CUSTOMER,
          refreshToken: data.refreshToken || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.set(id, user);
        return { ...user };
      },
      async update({ where, data }: any) {
        const user = users.get(where.id);
        if (!user) throw new Error('User not found');
        const updated = { ...user, ...data, updatedAt: new Date() };
        users.set(where.id, updated);
        return { ...updated };
      },
      async deleteMany() {
        users.clear();
        return { count: 0 };
      },
    },
    $disconnect: async () => {},
  } as any;
}

describe('STEP 2 ADVERSARIAL BREAK TESTS: Authentication, Security & RBAC', () => {
  let app: FastifyInstance;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = createInMemoryPrisma();
    app = await buildApp({ prismaClient: mockPrisma });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Adversarial Privilege Escalation Attacks', () => {
    it('MUST PREVENT privilege escalation during registration (forcing role to CUSTOMER even if ADMIN is requested)', async () => {
      const maliciousPayload = {
        email: 'hacker@cafe.in',
        password: 'Password123!',
        name: 'Evil Hacker',
        role: 'ADMIN', // Attacker trying to register as Owner/Admin!
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: maliciousPayload,
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.user.role).toBe(Role.CUSTOMER); // MUST be CUSTOMER!

      // Verify in DB that role was not tampered with
      const savedUser = await mockPrisma.user.findUnique({ where: { email: 'hacker@cafe.in' } });
      expect(savedUser.role).toBe(Role.CUSTOMER);
    });

    it('MUST BLOCK Customer tokens from accessing Staff-only and Admin-only routes with 403 Forbidden', async () => {
      // 1. Create a customer
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'customer@cafe.in',
          password: 'Password123!',
          name: 'Regular Customer',
        },
      });
      const customerToken = regRes.json().tokens.accessToken;

      // 2. Try hitting Staff route
      const staffAttempt = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/staff-only-test',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(staffAttempt.statusCode).toBe(403);
      expect(staffAttempt.json().code).toBe('INSUFFICIENT_PERMISSIONS');

      // 3. Try hitting Admin route
      const adminAttempt = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin-only-test',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(adminAttempt.statusCode).toBe(403);
      expect(adminAttempt.json().code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('MUST BLOCK Staff tokens from accessing Admin-only routes with 403 Forbidden', async () => {
      // Seed a staff user
      const staffUser = await mockPrisma.user.create({
        data: {
          email: 'barista@cafe.in',
          passwordHash: await bcrypt.hash('Password123!', 10),
          name: 'Barista Jack',
          role: Role.STAFF,
        },
      });

      // Issue staff JWT
      const staffToken = app.jwt.sign({
        id: staffUser.id,
        email: staffUser.email,
        role: Role.STAFF,
      });

      // Staff can access staff route
      const staffOk = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/staff-only-test',
        headers: { authorization: `Bearer ${staffToken}` },
      });
      expect(staffOk.statusCode).toBe(200);

      // Staff CANNOT access admin route
      const adminForbidden = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin-only-test',
        headers: { authorization: `Bearer ${staffToken}` },
      });
      expect(adminForbidden.statusCode).toBe(403);
      expect(adminForbidden.json().code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('MUST ALLOW Admin tokens to access both Staff and Admin routes', async () => {
      const adminUser = await mockPrisma.user.create({
        data: {
          email: 'owner@cafe.in',
          passwordHash: await bcrypt.hash('Password123!', 10),
          name: 'Owner Boss',
          role: Role.ADMIN,
        },
      });

      const adminToken = app.jwt.sign({
        id: adminUser.id,
        email: adminUser.email,
        role: Role.ADMIN,
      });

      const staffRouteRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/staff-only-test',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(staffRouteRes.statusCode).toBe(200);

      const adminRouteRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin-only-test',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(adminRouteRes.statusCode).toBe(200);
    });
  });

  describe('Adversarial Token Forgery & Header Manipulation Attacks', () => {
    it('MUST REJECT forged tokens signed with wrong secret key', async () => {
      // Forged JWT signed with a bogus key
      const forgedToken = (await import('jsonwebtoken')).default.sign(
        { id: 'fake-id', email: 'fake@cafe.in', role: 'ADMIN' },
        'malicious-attacker-secret-key-that-is-not-ours'
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin-only-test',
        headers: { authorization: `Bearer ${forgedToken}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('AUTH_TOKEN_INVALID');
    });

    it('MUST REJECT expired tokens with AUTH_TOKEN_EXPIRED error code', async () => {
      // Expired token signed with our real key but expired 10 seconds ago
      const expiredToken = app.jwt.sign(
        { id: 'user-123', email: 'test@cafe.in', role: Role.CUSTOMER },
        { expiresIn: '-10s' }
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${expiredToken}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('AUTH_TOKEN_EXPIRED');
    });

    it('MUST REJECT malformed authorization headers gracefully without crashing', async () => {
      const toxicHeaders = [
        undefined,
        'Bearer',
        'Bearer null',
        'Bearer undefined',
        'Bearer   ',
        'Basic dXNlcjpwYXNz',
        'Token 123456',
        '',
      ];

      for (const header of toxicHeaders) {
        const headers: any = {};
        if (header !== undefined) {
          headers.authorization = header;
        }

        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers,
        });

        expect(res.statusCode, `Header "${header}" should have returned 401`).toBe(401);
      }
    });
  });

  describe('Adversarial Refresh Token Rotation & Anti-Replay Defense', () => {
    it('MUST DETECT refresh token reuse (replay attack) and revoke the session', async () => {
      // 1. Register & login
      const reg = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'victim@cafe.in',
          password: 'Password123!',
          name: 'Victim User',
        },
      });
      const initialRefreshToken = reg.json().tokens.refreshToken;

      // 2. Legitimate refresh: rotates token from RefreshToken1 -> RefreshToken2
      const refresh1Res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: initialRefreshToken },
      });
      expect(refresh1Res.statusCode).toBe(200);
      const newRefreshToken = refresh1Res.json().tokens.refreshToken;
      expect(newRefreshToken).not.toBe(initialRefreshToken);

      // 3. ATTACK: Attacker intercepts and attempts to REUSE initialRefreshToken!
      const replayAttackRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: initialRefreshToken },
      });

      expect(replayAttackRes.statusCode).toBe(401);
      expect(replayAttackRes.json().code).toBe('REFRESH_TOKEN_REUSED');

      // 4. Verification: The user session was revoked in DB
      const userInDb = await mockPrisma.user.findUnique({ where: { email: 'victim@cafe.in' } });
      expect(userInDb.refreshToken).toBeNull();

      // 5. Even legitimate user with newRefreshToken is now forced to re-login due to the detected breach!
      const subsequentAttempt = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: newRefreshToken },
      });
      expect(subsequentAttempt.statusCode).toBe(401);
    });
  });

  describe('Adversarial Registration & Input Validation Attacks', () => {
    it('MUST REJECT duplicate email registrations with case-insensitive collision attack', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'rajesh@cafe.in',
          password: 'Password123!',
          name: 'Rajesh',
        },
      });

      // Attacker attempts registering with same email in UPPERCASE
      const duplicateRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'RAJESH@CAFE.IN',
          password: 'Password999!',
          name: 'Rajesh Duplicate',
        },
      });

      expect(duplicateRes.statusCode).toBe(409);
      expect(duplicateRes.json().code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('MUST REJECT weak passwords lacking minimum length or character classes', async () => {
      const weakPasswords = [
        'short1',         // Less than 8 chars
        'onlylettershere', // No numbers
        '1234567890',      // No letters
        '',
      ];

      for (const pwd of weakPasswords) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: {
            email: `test-${Math.random()}@cafe.in`,
            password: pwd,
            name: 'Weak Pass Tester',
          },
        });

        expect(res.statusCode, `Password "${pwd}" should have been rejected with 400`).toBe(400);
      }
    });
  });
});
