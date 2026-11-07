import { FastifyPluginAsync } from 'fastify';
import { Role } from '@prisma/client';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const authService = new AuthService(fastify.prisma, fastify);
  const controller = new AuthController(authService);

  // POST /register
  fastify.post(
    '/register',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
      schema: {
        tags: ['Authentication'],
        summary: 'Register a new customer account',
        body: {
          type: 'object',
          required: ['email', 'password', 'name'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
            name: { type: 'string', minLength: 2 },
          },
        },
        response: {
          201: {
            description: 'User registered successfully',
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
              tokens: {
                type: 'object',
                properties: {
                  accessToken: { type: 'string' },
                  refreshToken: { type: 'string' },
                  expiresIn: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    controller.register.bind(controller)
  );

  // POST /login
  fastify.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
      schema: {
        tags: ['Authentication'],
        summary: 'Sign in to existing account',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'User authenticated successfully',
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
              tokens: {
                type: 'object',
                properties: {
                  accessToken: { type: 'string' },
                  refreshToken: { type: 'string' },
                  expiresIn: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    controller.login.bind(controller)
  );

  // POST /refresh
  fastify.post(
    '/refresh',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Rotate and refresh JWT access token',
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
      },
    },
    controller.refresh.bind(controller)
  );

  // GET /me (Protected)
  fastify.get(
    '/me',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['Authentication'],
        summary: 'Retrieve authenticated user profile',
        security: [{ bearerAuth: [] }],
      },
    },
    controller.getMe.bind(controller)
  );

  // GET /staff-only-test (Staff & Admin RBAC Verification)
  fastify.get(
    '/staff-only-test',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.STAFF, Role.ADMIN])],
      schema: {
        tags: ['Authentication'],
        summary: 'Protected endpoint accessible only by Staff or Admin',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      return {
        message: 'Welcome to Staff/Kitchen Portal',
        user: request.user,
      };
    }
  );

  // GET /admin-only-test (Admin RBAC Verification)
  fastify.get(
    '/admin-only-test',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.ADMIN])],
      schema: {
        tags: ['Authentication'],
        summary: 'Protected endpoint accessible strictly by Admin',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      return {
        message: 'Welcome to Owner/Admin Management Console',
        user: request.user,
      };
    }
  );
};
