import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { PrismaClient } from '@prisma/client';
import { env } from './config/env.js';
import prismaPlugin from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { menuRoutes } from './modules/menu/menu.routes.js';
import { ordersRoutes } from './modules/orders/orders.routes.js';

export interface BuildAppOptions {
  prismaClient?: PrismaClient;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
  });

  // Security headers & sensible utilities
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(sensible);

  // CORS configuration for frontend dev
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim());
  await app.register(cors, {
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    credentials: true,
  });

  // Core Plugins: Prisma DB & JWT Auth
  await app.register(prismaPlugin, { client: options.prismaClient });
  await app.register(authPlugin);

  // Swagger OpenAPI Documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Artisan Cafe Backend API (India)',
        description: 'Production API for Cafe Ordering, Customizations, Concurrency-Safe Reservations, and INR Payments',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${env.PORT}`,
          description: 'Local Development Server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Route Modules
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(menuRoutes, { prefix: '/api/v1/menu' });
  await app.register(ordersRoutes, { prefix: '/api/v1/orders' });

  // Health check endpoint
  app.get('/health', async () => {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
      service: 'cafe-backend',
    };
  });

  return app;
}

async function start() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`🚀 Cafe Backend running at http://${env.HOST}:${env.PORT}`);
    console.log(`📚 Interactive OpenAPI Docs at http://${env.HOST}:${env.PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only start when invoked directly (not during tests)
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  start();
}
