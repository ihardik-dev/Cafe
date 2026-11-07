import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { Role } from '@prisma/client';
import { env } from '../config/env.js';

export interface UserTokenPayload {
  id: string;
  email: string;
  role: Role;
  jti?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuthenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authorize: (allowedRoles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: UserTokenPayload;
    user: UserTokenPayload;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
  });

  // Authentication pre-handler: verifies JWT validity & attaches user
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Missing Authorization header',
          code: 'AUTH_HEADER_MISSING',
        });
      }

      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1] || parts[1].trim() === '' || parts[1] === 'null' || parts[1] === 'undefined') {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Malformed or invalid Bearer token',
          code: 'AUTH_TOKEN_MALFORMED',
        });
      }

      await request.jwtVerify();
    } catch (err: any) {
      if (
        err.code === 'FAST_JWT_EXPIRED' ||
        err.name === 'TokenExpiredError' ||
        err.message?.toLowerCase().includes('expired')
      ) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication token has expired',
          code: 'AUTH_TOKEN_EXPIRED',
        });
      }

      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or forged authentication token',
        code: 'AUTH_TOKEN_INVALID',
      });
    }
  });

  // Optional authentication: extracts user if header is present, but does not block guests
  fastify.decorate('optionalAuthenticate', async (request: FastifyRequest) => {
    const authHeader = request.headers.authorization;
    if (!authHeader) return;

    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0]?.toLowerCase() === 'bearer' && parts[1]) {
      try {
        await request.jwtVerify();
      } catch {
        // Guest mode: continue without user attachment
      }
    }
  });

  // Authorization pre-handler: verifies that the authenticated user possesses one of the allowed roles
  fastify.decorate('authorize', (allowedRoles: Role[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      // First ensure the request was authenticated
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'User authentication required',
          code: 'UNAUTHENTICATED',
        });
      }

      if (!allowedRoles.includes(request.user.role)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Forbidden: requires one of the following roles: [${allowedRoles.join(', ')}]`,
          code: 'INSUFFICIENT_PERMISSIONS',
        });
      }
    };
  });
};

export default fp(authPlugin, {
  name: 'auth-plugin',
});
