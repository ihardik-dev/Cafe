import { PrismaClient, Role, TableArea } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Production Safeguard: Never allow destructive deletion of database in production
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DESTRUCTIVE_SEED !== 'true') {
    console.error('❌ FATAL: Destructive seeding is blocked in production environment to prevent irreversible data loss.');
    console.error('If you deliberately wish to execute a destructive reset, set ALLOW_DESTRUCTIVE_SEED=true.');
    process.exit(1);
  }

  console.log('🌱 Starting Cafe Database Seeding (Indian Rupee / Paise Pricing)...');

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
      email: 'admin@artisanroasters.in',
      passwordHash: defaultPasswordHash,
      name: 'Owner Admin',
      role: Role.ADMIN,
    },
  });

  const staff = await prisma.user.create({
    data: {
      email: 'barista@artisanroasters.in',
      passwordHash: defaultPasswordHash,
      name: 'Head Barista Jack',
      role: Role.STAFF,
    },
  });

  const customer = await prisma.user.create({
    data: {
      email: 'customer@example.in',
      passwordHash: defaultPasswordHash,
      name: 'Aarav Sharma',
      role: Role.CUSTOMER,
    },
  });

  console.log(`✅ Users seeded: ${admin.email}, ${staff.email}, ${customer.email}`);

  // 3. Seed Categories
  const catCoffee = await prisma.category.create({
    data: {
      name: 'Specialty Coffee',
      description: 'Chikmagalur & Coorg single-origin beans roasted with precision',
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
      name: 'Gourmet Sandwiches & Brunch',
      description: 'Toasted organic sourdough paninis, sourdough toasts, and cafe specials',
      displayOrder: 3,
    },
  });

  const catCold = await prisma.category.create({
    data: {
      name: 'Cold Brews & Tonics',
      description: '18-hour cold brew and sparkling citrus tonics',
      displayOrder: 4,
    },
  });

  console.log('✅ Categories seeded');

  // 4. Seed Menu Items & Modifiers (Prices in Paise: ₹1 = 100 paise)

  // Item 1: Signature Flat White (₹240 = 24,000 paise)
  const flatWhite = await prisma.menuItem.create({
    data: {
      categoryId: catCoffee.id,
      name: 'Signature Flat White',
      description: 'Double ristretto shot with velvety microfoam steamed milk',
      priceInPaise: 24000, // ₹240.00
      imageUrl: 'https://images.unsplash.com/photo-1577968897966-3d4325b36b61?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: false,
    },
  });

  // Flat White Modifier Groups
  await prisma.modifierGroup.create({
    data: {
      menuItemId: flatWhite.id,
      name: 'Milk Choice',
      minSelection: 1,
      maxSelection: 1,
      options: {
        create: [
          { name: 'Whole Dairy Milk', extraPriceInPaise: 0, isAvailable: true },
          { name: 'Oat Milk (Barista Edition)', extraPriceInPaise: 6000, isAvailable: true }, // +₹60
          { name: 'Almond Milk (Unsweetened)', extraPriceInPaise: 5000, isAvailable: true },  // +₹50
          { name: 'Skim Milk', extraPriceInPaise: 0, isAvailable: true },
        ],
      },
    },
  });

  await prisma.modifierGroup.create({
    data: {
      menuItemId: flatWhite.id,
      name: 'Espresso Shots',
      minSelection: 0,
      maxSelection: 3,
      options: {
        create: [
          { name: 'Extra Single Origin Shot', extraPriceInPaise: 7000, isAvailable: true }, // +₹70
          { name: 'Decaf Roast', extraPriceInPaise: 4000, isAvailable: true },              // +₹40
        ],
      },
    },
  });

  // Item 2: South Indian Artisanal Filter Coffee (₹160 = 16,000 paise)
  await prisma.menuItem.create({
    data: {
      categoryId: catCoffee.id,
      name: 'Artisanal South Indian Filter Coffee',
      description: 'Slow-drip 80/20 plantation blend with chicory and frothy dairy milk',
      priceInPaise: 16000, // ₹160.00
      imageUrl: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: false,
    },
  });

  // Item 3: 18-Hour Single Origin Cold Brew (₹260 = 26,000 paise)
  await prisma.menuItem.create({
    data: {
      categoryId: catCold.id,
      name: '18-Hour Single Origin Cold Brew',
      description: 'Slow steeped Ethiopian & Chikmagalur beans with deep chocolate notes',
      priceInPaise: 26000, // ₹260.00
      imageUrl: 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: false,
    },
  });

  // Item 4: Double-Baked Almond Croissant (₹220 = 22,000 paise, Perishable)
  const almondCroissant = await prisma.menuItem.create({
    data: {
      categoryId: catBakery.id,
      name: 'Double-Baked Almond Croissant',
      description: 'Twice-baked French butter croissant filled with nutty frangipane cream',
      priceInPaise: 22000, // ₹220.00
      imageUrl: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: true,
    },
  });

  await prisma.inventoryItem.create({
    data: {
      menuItemId: almondCroissant.id,
      stockQuantity: 10,
      lowStockThreshold: 3,
    },
  });

  // Item 5: French Pain au Chocolat (₹210 = 21,000 paise, Perishable)
  const painAuChocolat = await prisma.menuItem.create({
    data: {
      categoryId: catBakery.id,
      name: 'Belgian Dark Pain au Chocolat',
      description: 'Flaky viennoiserie pastry enclosing two batons of Belgian dark chocolate',
      priceInPaise: 21000, // ₹210.00
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

  // Item 6: Bombay Masala Grilled Panini (₹260 = 26,000 paise)
  await prisma.menuItem.create({
    data: {
      categoryId: catSandwiches.id,
      name: 'Bombay Masala Sourdough Panini',
      description: 'Spiced potato filling, mint chutney, bell peppers, and melted Amul cheese on sourdough',
      priceInPaise: 26000, // ₹260.00
      imageUrl: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: false,
    },
  });

  // Item 7: Truffle Mushroom & Gruyere Melt (₹380 = 38,000 paise)
  await prisma.menuItem.create({
    data: {
      categoryId: catSandwiches.id,
      name: 'Truffle Mushroom Sourdough Melt',
      description: 'Roasted cremini mushrooms, aged Gruyere cheese, caramelized onions, and white truffle glaze',
      priceInPaise: 38000, // ₹380.00
      imageUrl: 'https://images.unsplash.com/photo-1509722747041-616f39b57569?auto=format&fit=crop&w=600&q=80',
      isAvailable: true,
      isPerishable: false,
    },
  });

  console.log('✅ Menu items, modifiers, and inventory items seeded in INR / Paise');

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
  console.log('🎉 Database seeding complete (All prices in INR / Paise)!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
