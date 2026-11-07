import { FastifyReply, FastifyRequest } from 'fastify';
import { MenuService } from './menu.service.js';
import {
  createMenuItemSchema,
  createModifierGroupSchema,
  createModifierOptionSchema,
} from './menu.schema.js';
import { z } from 'zod';

const createCategorySchema = z.object({
  name: z.string().min(2).max(100).trim(),
  description: z.string().max(500).optional(),
  displayOrder: z.number().int().optional(),
});

const updateStockSchema = z.object({
  stockQuantity: z.number().int().min(0, 'Stock cannot be negative'),
});

const toggleAvailabilitySchema = z.object({
  isAvailable: z.boolean(),
});

export class MenuController {
  constructor(private menuService: MenuService) {}

  async getCategories(_request: FastifyRequest, reply: FastifyReply) {
    const categories = await this.menuService.getCategories();
    return reply.status(200).send({ categories });
  }

  async getFullMenu(_request: FastifyRequest, reply: FastifyReply) {
    const menu = await this.menuService.getFullMenu();
    return reply.status(200).send({ menu });
  }

  async getItemDetails(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    try {
      const item = await this.menuService.getItemDetails(request.params.id);
      return reply.status(200).send({ item });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async createCategory(request: FastifyRequest, reply: FastifyReply) {
    const parsed = createCategorySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    try {
      const category = await this.menuService.createCategory(parsed.data);
      return reply.status(201).send({ category });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async createMenuItem(request: FastifyRequest, reply: FastifyReply) {
    const parsed = createMenuItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    try {
      const item = await this.menuService.createMenuItem(parsed.data);
      return reply.status(201).send({ item });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async createModifierGroup(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const payload = { ...(request.body as any), menuItemId: request.params.id };
    const parsed = createModifierGroupSchema.safeParse(payload);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    try {
      const group = await this.menuService.createModifierGroup(parsed.data);
      return reply.status(201).send({ group });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async createModifierOption(request: FastifyRequest<{ Params: { groupId: string } }>, reply: FastifyReply) {
    const payload = { ...(request.body as any), groupId: request.params.groupId };
    const parsed = createModifierOptionSchema.safeParse(payload);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    try {
      const option = await this.menuService.createModifierOption(parsed.data);
      return reply.status(201).send({ option });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async updateStock(request: FastifyRequest<{ Params: { menuItemId: string } }>, reply: FastifyReply) {
    const parsed = updateStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    try {
      const inventory = await this.menuService.updateStock(request.params.menuItemId, parsed.data.stockQuantity);
      return reply.status(200).send({ inventory });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }

  async toggleAvailability(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const parsed = toggleAvailabilitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    try {
      const item = await this.menuService.toggleItemAvailability(request.params.id, parsed.data.isAvailable);
      return reply.status(200).send({ item });
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({
        statusCode: err.statusCode || 500,
        error: err.name || 'Error',
        message: err.message,
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  }
}
