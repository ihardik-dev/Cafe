import { FastifyPluginAsync } from 'fastify';
import { Role } from '@prisma/client';
import { MenuService } from './menu.service.js';
import { MenuController } from './menu.controller.js';

export const menuRoutes: FastifyPluginAsync = async (fastify) => {
  const menuService = new MenuService(fastify.prisma);
  const controller = new MenuController(menuService);

  // ----------------------------------------------------
  // PUBLIC ROUTES (Customer Menu Browsing)
  // ----------------------------------------------------

  fastify.get(
    '/categories',
    {
      schema: {
        tags: ['Menu'],
        summary: 'List active menu categories',
      },
    },
    controller.getCategories.bind(controller)
  );

  fastify.get(
    '/',
    {
      schema: {
        tags: ['Menu'],
        summary: 'Get complete active cafe menu with items and modifier options',
      },
    },
    controller.getFullMenu.bind(controller)
  );

  fastify.get(
    '/items/:id',
    {
      schema: {
        tags: ['Menu'],
        summary: 'Get details for a specific menu item including available modifiers',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    controller.getItemDetails.bind(controller) as any
  );

  // ----------------------------------------------------
  // PROTECTED ADMIN & STAFF ROUTES
  // ----------------------------------------------------

  // Category creation (Admin only)
  fastify.post(
    '/categories',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.ADMIN])],
      schema: {
        tags: ['Menu Admin'],
        summary: 'Create a new menu category (Admin only)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2 },
            description: { type: 'string' },
            displayOrder: { type: 'integer' },
          },
        },
      },
    },
    controller.createCategory.bind(controller)
  );

  // Menu item creation (Admin only)
  fastify.post(
    '/items',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.ADMIN])],
      schema: {
        tags: ['Menu Admin'],
        summary: 'Create a new menu item (Admin only)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['categoryId', 'name', 'priceInPaise'],
          properties: {
            categoryId: { type: 'string' },
            name: { type: 'string', minLength: 2 },
            description: { type: 'string' },
            priceInPaise: { type: 'integer', minimum: 0 },
            imageUrl: { type: 'string' },
            isAvailable: { type: 'boolean' },
            isPerishable: { type: 'boolean' },
          },
        },
      },
    },
    controller.createMenuItem.bind(controller)
  );

  // Modifier group creation (Admin only)
  fastify.post(
    '/items/:id/modifier-groups',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.ADMIN])],
      schema: {
        tags: ['Menu Admin'],
        summary: 'Create a modifier group for an item (Admin only)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2 },
            minSelection: { type: 'integer', minimum: 0 },
            maxSelection: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    controller.createModifierGroup.bind(controller) as any
  );

  // Modifier option creation (Admin only)
  fastify.post(
    '/modifier-groups/:groupId/options',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.ADMIN])],
      schema: {
        tags: ['Menu Admin'],
        summary: 'Create a modifier option inside a group (Admin only)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['groupId'],
          properties: { groupId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['name', 'extraPriceInPaise'],
          properties: {
            name: { type: 'string', minLength: 1 },
            extraPriceInPaise: { type: 'integer', minimum: 0 },
            isAvailable: { type: 'boolean' },
          },
        },
      },
    },
    controller.createModifierOption.bind(controller) as any
  );

  // Toggle availability (Staff & Admin)
  fastify.patch(
    '/items/:id/availability',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.STAFF, Role.ADMIN])],
      schema: {
        tags: ['Menu Admin'],
        summary: 'Toggle menu item availability (Staff & Admin)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['isAvailable'],
          properties: { isAvailable: { type: 'boolean' } },
        },
      },
    },
    controller.toggleAvailability.bind(controller) as any
  );

  // Update inventory stock (Staff & Admin)
  fastify.patch(
    '/inventory/:menuItemId',
    {
      preHandler: [fastify.authenticate, fastify.authorize([Role.STAFF, Role.ADMIN])],
      schema: {
        tags: ['Menu Admin'],
        summary: 'Update stock quantity for perishable item (Staff & Admin)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['menuItemId'],
          properties: { menuItemId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['stockQuantity'],
          properties: {
            stockQuantity: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    controller.updateStock.bind(controller) as any
  );
};
