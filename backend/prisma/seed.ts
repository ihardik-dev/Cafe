import { PrismaClient, Role, TableArea } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting Cafe Database Seeding...');

  // 1. Clean existing records (in reverse dependency order)
  await prisma.refundAudit.deleteMany();
  await prisma.inboundWebhookEvent.deleteMany();
  await prisma.reservationHold.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.table.deleteMany();
  await prisma.orderStatusHistory.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.inventoryItem.deleteMany();
  await prisma.modifierOption.deleteMany();
  await prisma.modifierGroup.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();

  // 2. Seed Default Users with secure hashed passwords
  const defaultPasswordHash = await bcrypt.hash('CafePassword123!', 10);

  const admin = await prisma.user.create({
    data: {
      email: 'admin@artisanroasters.com',
      passwordHash: defaultPasswordHash,
      name: 'Owner Admin',
      role: Role.ADMIN,
    },
  });

  const staff = await prisma.user.create({
    data: {
      email: 'barista@artisanroasters.com',
      passwordHash: defaultPasswordHash,
      name: 'Head Barista Jack',
      role: Role.STAFF,
    },
  });

  const customer = await prisma.user.create({
    data: {
      email: 'customer@example.com',
      passwordHash: defaultPasswordHash,
      name: 'Alice Coffee Lover',
      role: Role.CUSTOMER,
    },
  });

  console.log(`✅ Users seeded: ${admin.email}, ${staff.email}, ${customer.email}`);

  // 3. Seed Categories
  const catCoffee = await prisma.category.create({
    data: {
      name: 'Specialty Coffee',
      description: 'Single-origin beans roasted in-house with precision extraction',
      displayOrder: 1,
    },
  });

  const catBakery = await prisma.category.create({
    data: {
      name: 'Artisan Bakery',
      description: 'Freshly baked every morning with French cultured butter',
      displayOrder: 2,
    },
  });

  const catSandwiches = await prisma.category.create({
    data: {
      name: 'Gourmet Sandwiches',
      description: 'Toasted organic sourdough paninis and brunch plates',
      displayOrder: 3,
    },
  });

  const catCold = await prisma.category.create({
    data: {
      name: 'Cold Beverages',
      description: '18-hour cold brew and sparkling tonics',
      displayOrder: 4,
    },
  });

  console.log('✅ Categories seeded');

  // 4. Seed Menu Items & Modifiers

  // Item 1: Flat White
  const flatWhite = await prisma.menuItem.create({
    data: {
      categoryId: catCoffee.id,
      name: 'Signature Flat White',
      description: 'Double ristretto shot with velvety microfoam steamed milk',
      priceInCents: 475, // $4.75
      imageUrl: 'https://images.unsplash.com/photo-1577968897966-3d4325b36b61?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: false,
    },
  });

  // Flat White Modifier Groups
  const milkGroup = await prisma.modifierGroup.create({
    data: {
      menuItemId: flatWhite.id,
      name: 'Milk Choice',
      minSelection: 1,
      maxSelection: 1,
      options: {
        create: [
          { name: 'Whole Milk (Standard)', extraPriceInCents: 0, isAvailable: true },
          { name: 'Oat Milk (Minor Figures)', extraPriceInCents: 75, isAvailable: true },
          { name: 'Almond Milk (Unsweetened)', extraPriceInCents: 60, isAvailable: true },
          { name: 'Skim Milk', extraPriceInCents: 0, isAvailable: true },
        ],
      },
    },
  });

  const shotGroup = await prisma.modifierGroup.create({
    data: {
      menuItemId: flatWhite.id,
      name: 'Espresso Shots',
      minSelection: 0,
      maxSelection: 3,
      options: {
        create: [
          { name: 'Extra Espresso Shot', extraPriceInCents: 100, isAvailable: true },
          { name: 'Decaf Blend', extraPriceInCents: 50, isAvailable: true },
        ],
      },
    },
  });

  // Item 2: 18-Hour Kyoto Cold Brew
  await prisma.menuItem.create({
    data: {
      categoryId: catCold.id,
      name: 'Kyoto-Style Cold Brew',
      description: 'Slow-drip single origin Ethiopian Guji with floral and berry notes',
      priceInCents: 525, // $5.25
      imageUrl: 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: false,
    },
  });

  // Item 3: Almond Croissant (Perishable with finite stock)
  const almondCroissant = await prisma.menuItem.create({
    data: {
      categoryId: catBakery.id,
      name: 'Double-Baked Almond Croissant',
      description: 'Twice-baked butter croissant filled with frangipane and topped with sliced almonds',
      priceInCents: 450, // $4.50
      imageUrl: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: true,
    },
  });

  // Add finite inventory for Almond Croissant (e.g. 10 baked daily)
  await prisma.inventoryItem.create({
    data: {
      menuItemId: almondCroissant.id,
      stockQuantity: 10,
      lowStockThreshold: 3,
    },
  });

  // Item 4: Pain au Chocolat (Perishable with finite stock)
  const painAuChocolat = await prisma.menuItem.create({
    data: {
      categoryId: catBakery.id,
      name: 'French Butter Pain au Chocolat',
      description: 'Flaky viennoiserie pastry enclosing two batons of Valrhona dark chocolate',
      priceInCents: 425, // $4.25
      imageUrl: 'https://images.unsplash.com/photo-1530610476181-d83430b64dcd?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: true,
    },
  });

  await prisma.inventoryItem.create({
    data: {
      menuItemId: painAuChocolat.id,
      stockQuantity: 8,
      lowStockThreshold: 2,
    },
  });

  // Item 5: Truffle Mushroom & Gruyere Sourdough Panini
  await prisma.menuItem.create({
    data: {
      categoryId: catSandwiches.id,
      name: 'Truffle Mushroom Sourdough Melt',
      description: 'Roasted cremini mushrooms, aged Gruyere cheese, caramelized onions, and white truffle oil',
      priceInCents: 1150, // $11.50
      imageUrl: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: false,
    },
  });

  console.log('✅ Menu items, modifiers, and inventory items seeded');

  // 5. Seed Tables for Reservations
  const tables = [
    { tableNumber: 1, capacity: 2, area: TableArea.INDOOR },
    { tableNumber: 2, capacity: 2, area: TableArea.INDOOR },
    { tableNumber: 3, capacity: 4, area: TableArea.INDOOR },
    { tableNumber: 4, capacity: 4, area: TableArea.PATIO },
    { tableNumber: 5, capacity: 6, area: TableArea.PATIO },
    { tableNumber: 6, capacity: 2, area: TableArea.BAR_COUNTER },
  ];

  for (const t of tables) {
    await prisma.table.create({ data: t });
  }

  console.log(`✅ ${tables.length} Cafe tables seeded`);
  console.log('🎉 Database seeding complete!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
