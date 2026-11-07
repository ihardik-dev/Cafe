import { PrismaClient } from '@prisma/client';
import {
  CreateMenuItemInput,
  CreateModifierGroupInput,
  CreateModifierOptionInput,
} from './menu.schema.js';

export interface CartItemToValidate {
  menuItemId: string;
  quantity: number;
  selectedModifierOptionIds: string[];
}

export interface ValidatedCartItemResult {
  menuItemId: string;
  name: string;
  unitPriceInPaise: number;
  quantity: number;
  totalPriceInPaise: number;
  modifiers: {
    modifierOptionId: string;
    name: string;
    extraPriceInPaise: number;
  }[];
}

export class MenuService {
  constructor(private prisma: PrismaClient) {}

  // ----------------------------------------------------
  // PUBLIC MENU QUERIES
  // ----------------------------------------------------

  async getCategories() {
    return this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
    });
  }

  async getFullMenu() {
    const categories = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      include: {
        items: {
          where: { isAvailable: true },
          include: {
            inventory: true,
            modifierGroups: {
              include: {
                options: {
                  where: { isAvailable: true },
                },
              },
            },
          },
        },
      },
    });

    // Public Menu Protection: Strip raw stockQuantity and lowStockThreshold to prevent inventory leaks
    return categories.map((cat) => ({
      ...cat,
      items: cat.items.map((item) => {
        const inStock = !item.isPerishable || (item.inventory ? item.inventory.stockQuantity > 0 : true);
        const { inventory, ...publicFields } = item;
        return {
          ...publicFields,
          inStock,
        };
      }),
    }));
  }

  async getItemDetails(itemId: string) {
    const item = await this.prisma.menuItem.findUnique({
      where: { id: itemId },
      include: {
        inventory: true,
        category: true,
        modifierGroups: {
          include: {
            options: true,
          },
        },
      },
    });

    if (!item) {
      const err: any = new Error('Menu item not found');
      err.statusCode = 404;
      err.code = 'ITEM_NOT_FOUND';
      throw err;
    }

    const inStock = !item.isPerishable || (item.inventory ? item.inventory.stockQuantity > 0 : true);
    const { inventory, ...publicFields } = item;
    return {
      ...publicFields,
      inStock,
    };
  }

  // ----------------------------------------------------
  // ADMIN MENU MANAGEMENT
  // ----------------------------------------------------

  async createCategory(data: { name: string; description?: string; displayOrder?: number }) {
    const existing = await this.prisma.category.findUnique({ where: { name: data.name } });
    if (existing) {
      const err: any = new Error(`Category "${data.name}" already exists`);
      err.statusCode = 409;
      err.code = 'CATEGORY_ALREADY_EXISTS';
      throw err;
    }

    return this.prisma.category.create({
      data: {
        name: data.name,
        description: data.description,
        displayOrder: data.displayOrder ?? 0,
      },
    });
  }

  async createMenuItem(data: CreateMenuItemInput) {
    const category = await this.prisma.category.findUnique({ where: { id: data.categoryId } });
    if (!category) {
      const err: any = new Error('Category not found');
      err.statusCode = 404;
      err.code = 'CATEGORY_NOT_FOUND';
      throw err;
    }

    return this.prisma.$transaction(async (tx) => {
      const item = await tx.menuItem.create({
        data: {
          categoryId: data.categoryId,
          name: data.name,
          description: data.description,
          priceInPaise: data.priceInPaise,
          imageUrl: data.imageUrl,
          isAvailable: data.isAvailable,
          isPerishable: data.isPerishable,
        },
      });

      // If marked perishable, initialize inventory record atomically
      if (data.isPerishable) {
        await tx.inventoryItem.create({
          data: {
            menuItemId: item.id,
            stockQuantity: 0,
          },
        });
      }

      return item;
    });
  }

  async createModifierGroup(data: CreateModifierGroupInput) {
    const item = await this.prisma.menuItem.findUnique({ where: { id: data.menuItemId } });
    if (!item) {
      const err: any = new Error('Menu item not found');
      err.statusCode = 404;
      err.code = 'ITEM_NOT_FOUND';
      throw err;
    }

    return this.prisma.modifierGroup.create({
      data: {
        menuItemId: data.menuItemId,
        name: data.name,
        minSelection: data.minSelection,
        maxSelection: data.maxSelection,
      },
    });
  }

  async createModifierOption(data: CreateModifierOptionInput) {
    const group = await this.prisma.modifierGroup.findUnique({ where: { id: data.groupId } });
    if (!group) {
      const err: any = new Error('Modifier group not found');
      err.statusCode = 404;
      err.code = 'GROUP_NOT_FOUND';
      throw err;
    }

    return this.prisma.modifierOption.create({
      data: {
        groupId: data.groupId,
        name: data.name,
        extraPriceInPaise: data.extraPriceInPaise,
        isAvailable: data.isAvailable,
      },
    });
  }

  async toggleItemAvailability(itemId: string, isAvailable: boolean) {
    return this.prisma.menuItem.update({
      where: { id: itemId },
      data: { isAvailable },
    });
  }

  async updateStock(menuItemId: string, newStockQuantity: number) {
    if (newStockQuantity < 0) {
      const err: any = new Error('Stock quantity cannot be negative');
      err.statusCode = 400;
      err.code = 'INVALID_STOCK_QUANTITY';
      throw err;
    }

    const item = await this.prisma.menuItem.findUnique({ where: { id: menuItemId } });
    if (!item) {
      const err: any = new Error('Menu item not found');
      err.statusCode = 404;
      err.code = 'ITEM_NOT_FOUND';
      throw err;
    }

    return this.prisma.inventoryItem.upsert({
      where: { menuItemId },
      update: { stockQuantity: newStockQuantity },
      create: { menuItemId, stockQuantity: newStockQuantity },
    });
  }

  // ----------------------------------------------------
  // ADVERSARIAL VALIDATION: MODIFIERS & CART INTEGRITY
  // ----------------------------------------------------

  /**
   * Validates that:
   * 1. Item exists and is available.
   * 2. All selected modifier options strictly belong to modifier groups assigned to this item.
   * 3. No disabled modifier options are selected.
   * 4. Modifier group min/max selection bounds are strictly respected.
   * 5. Returns server-calculated item total price (unit + modifiers) in paise.
   */
  async validateCartItem(cartItem: CartItemToValidate): Promise<ValidatedCartItemResult> {
    const item = await this.prisma.menuItem.findUnique({
      where: { id: cartItem.menuItemId },
      include: {
        modifierGroups: {
          include: {
            options: true,
          },
        },
      },
    });

    if (!item || !item.isAvailable) {
      const err: any = new Error(`Item "${cartItem.menuItemId}" is currently unavailable or does not exist`);
      err.statusCode = 400;
      err.code = 'ITEM_UNAVAILABLE';
      throw err;
    }

    // Build map of allowed option IDs and their parent group
    const allowedOptionMap = new Map<string, { option: any; group: any }>();
    for (const group of item.modifierGroups) {
      for (const opt of group.options) {
        allowedOptionMap.set(opt.id, { option: opt, group });
      }
    }

    // Group selected options by their parent modifier group
    const selectedByGroup = new Map<string, any[]>();
    const validatedModifiers: { modifierOptionId: string; name: string; extraPriceInPaise: number }[] = [];
    const optionIdsToProcess = cartItem.selectedModifierOptionIds || [];

    for (const optId of optionIdsToProcess) {
      const entry = allowedOptionMap.get(optId);

      // Adversarial Check: Disallow injecting modifiers from other items
      if (!entry) {
        const err: any = new Error(`Modifier option ${optId} does not belong to item "${item.name}"`);
        err.statusCode = 400;
        err.code = 'MODIFIER_DOES_NOT_BELONG_TO_ITEM';
        throw err;
      }

      // Adversarial Check: Disallow selecting unavailable modifier options
      if (!entry.option.isAvailable) {
        const err: any = new Error(`Modifier option "${entry.option.name}" is currently unavailable`);
        err.statusCode = 400;
        err.code = 'MODIFIER_UNAVAILABLE';
        throw err;
      }

      const existingInGroup = selectedByGroup.get(entry.group.id) || [];
      existingInGroup.push(entry.option);
      selectedByGroup.set(entry.group.id, existingInGroup);

      validatedModifiers.push({
        modifierOptionId: entry.option.id,
        name: entry.option.name,
        extraPriceInPaise: entry.option.extraPriceInPaise,
      });
    }

    // Adversarial Check: Verify minSelection and maxSelection for each modifier group on the item
    for (const group of item.modifierGroups) {
      const count = (selectedByGroup.get(group.id) || []).length;
      if (count < group.minSelection) {
        const err: any = new Error(
          `Modifier group "${group.name}" requires at least ${group.minSelection} selection(s), but ${count} were provided`
        );
        err.statusCode = 400;
        err.code = 'MODIFIER_MIN_SELECTION_NOT_MET';
        throw err;
      }

      if (count > group.maxSelection) {
        const err: any = new Error(
          `Modifier group "${group.name}" allows at most ${group.maxSelection} selection(s), but ${count} were selected`
        );
        err.statusCode = 400;
        err.code = 'MODIFIER_MAX_SELECTION_EXCEEDED';
        throw err;
      }
    }

    // Server-side financial calculation (strictly integer paise)
    const modifiersTotalExtraInPaise = validatedModifiers.reduce((acc, m) => acc + m.extraPriceInPaise, 0);
    const basePrice = item.priceInPaise ?? (item as any).basePriceInPaise ?? 0;
    const unitPriceInPaise = basePrice + modifiersTotalExtraInPaise;
    const totalPriceInPaise = unitPriceInPaise * cartItem.quantity;

    return {
      menuItemId: item.id,
      name: item.name,
      unitPriceInPaise,
      quantity: cartItem.quantity,
      totalPriceInPaise,
      modifiers: validatedModifiers,
    };
  }

  // ----------------------------------------------------
  // CONCURRENCY-SAFE ATOMIC INVENTORY DEDUCTION
  // ----------------------------------------------------

  /**
   * Atomically decrements stock for perishable items with zero race conditions.
   * If stock is insufficient, rolls back and throws INSUFFICIENT_STOCK.
   * Accepts an optional existing transaction client (tx) to prevent nested transaction deadlocks!
   */
  async deductInventoryAtomic(items: { menuItemId: string; quantity: number }[], tx?: any) {
    const execute = async (client: any) => {
      for (const item of items) {
        const menuItem = await client.menuItem.findUnique({
          where: { id: item.menuItemId },
          include: { inventory: true },
        });

        if (!menuItem || !menuItem.isPerishable) {
          // Non-perishable items don't have finite daily limits
          continue;
        }

        // Perishable item MUST have an inventory record.
        // If missing, fail closed to prevent infinite stock loopholes!
        if (!menuItem.inventory) {
          const err: any = new Error(
            `Inventory record missing for perishable item "${menuItem.name}". System fails closed to prevent infinite overselling.`
          );
          err.statusCode = 500;
          err.code = 'INVENTORY_RECORD_MISSING';
          throw err;
        }

        // Database-level conditional atomic decrement:
        // Guarantees zero negative stock even under extreme concurrency!
        const updateResult = await client.inventoryItem.updateMany({
          where: {
            menuItemId: item.menuItemId,
            stockQuantity: {
              gte: item.quantity,
            },
          },
          data: {
            stockQuantity: {
              decrement: item.quantity,
            },
          },
        });

        if (updateResult.count !== 1) {
          const err: any = new Error(
            `Insufficient stock for "${menuItem.name}". Available stock is less than requested quantity (${item.quantity}).`
          );
          err.statusCode = 409;
          err.code = 'INSUFFICIENT_STOCK';
          throw err;
        }
      }
    };

    if (tx) {
      return execute(tx);
    }
    return this.prisma.$transaction(execute);
  }

  /**
   * Atomically restores inventory stock when an order is cancelled or times out.
   */
  async restoreInventoryAtomic(items: { menuItemId: string; quantity: number }[], tx?: any) {
    const execute = async (client: any) => {
      for (const item of items) {
        const menuItem = await client.menuItem.findUnique({
          where: { id: item.menuItemId },
          include: { inventory: true },
        });

        if (!menuItem || !menuItem.isPerishable || !menuItem.inventory) {
          continue;
        }

        await client.inventoryItem.update({
          where: { id: menuItem.inventory.id },
          data: {
            stockQuantity: {
              increment: item.quantity,
            },
          },
        });
      }
    };

    if (tx) {
      return execute(tx);
    }
    return this.prisma.$transaction(execute);
  }
}
