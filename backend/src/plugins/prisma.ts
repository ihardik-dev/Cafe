import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface PrismaPluginOptions {
  client?: PrismaClient;
}

const prismaPlugin: FastifyPluginAsync<PrismaPluginOptions> = async (fastify, options) => {
  const prisma = options.client || new PrismaClient({
    log: fastify.log.level === 'debug' ? ['query', 'info', 'warn', 'error'] : ['error'],
  });

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async (server) => {
    await server.prisma.$disconnect();
  });
};

export default fp(prismaPlugin, {
  name: 'prisma-plugin',
});
