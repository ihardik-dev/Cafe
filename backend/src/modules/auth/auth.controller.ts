import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service.js';
import { registerSchema, loginSchema, refreshTokenSchema } from './auth.schema.js';

export class AuthController {
  constructor(private authService: AuthService) {}

  async register(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = registerSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const result = await this.authService.register(parseResult.data);
      return reply.status(201).send(result);
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'InternalServerError',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async login(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = loginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const result = await this.authService.login(parseResult.data);
      return reply.status(200).send(result);
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'InternalServerError',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async refresh(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = refreshTokenSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parseResult.error.format(),
      });
    }

    try {
      const result = await this.authService.refreshToken(parseResult.data.refreshToken);
      return reply.status(200).send(result);
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'InternalServerError',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async getMe(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user = await this.authService.getProfile(request.user.id);
      return reply.status(200).send({ user });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'InternalServerError',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }
}
