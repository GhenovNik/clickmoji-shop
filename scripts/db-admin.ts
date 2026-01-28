import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { GoogleGenAI } from '@google/genai';
import { UTApi } from 'uploadthing/server';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

type Command =
  | 'verify-users'
  | 'reassign-products'
  | 'check-db'
  | 'check-lists'
  | 'check-constraint'
  | 'check-duplicates'
  | 'remove-duplicate-items'
  | 'remove-duplicate-products'
  | 'fix-categories'
  | 'add-new-categories'
  | 'add-note-column'
  | 'import-products'
  | 'create-admin'
  | 'create-test-user'
  | 'export-neon'
  | 'import-to-local'
  | 'migrate-data'
  | 'cleanup-orphaned-files'
  | 'cleanup-unused-images';

const commands: Command[] = [
  'verify-users',
  'reassign-products',
  'check-db',
  'check-lists',
  'check-constraint',
  'check-duplicates',
  'remove-duplicate-items',
  'remove-duplicate-products',
  'fix-categories',
  'add-new-categories',
  'add-note-column',
  'import-products',
  'create-admin',
  'create-test-user',
  'export-neon',
  'import-to-local',
  'migrate-data',
  'cleanup-orphaned-files',
  'cleanup-unused-images',
];

type ReassignRule = {
  categoryName: string;
  productNames: string[];
};

const reassignRules: ReassignRule[] = [
  {
    categoryName: 'Рыба и морепродукты',
    productNames: [
      'Лобстер',
      'Креветки',
      'Краб',
      'Осьминог',
      'Кальмар',
      'Мидии',
      'Икра',
      'Рыба',
      'Лосось',
      'Тунец',
      'Сельдь',
    ],
  },
  {
    categoryName: 'Сладости',
    productNames: [
      'Шоколад',
      'Конфеты',
      'Печенье',
      'Кекс',
      'Торт',
      'Пирожные',
      'Мороженое',
      'Вафли',
      'Пудинг',
      'Мармелад',
      'Зефир',
    ],
  },
];

const newCategories = [
  {
    name: 'Крупы и макароны',
    nameEn: 'Grains & Pasta',
    emoji: '🌾',
    order: 13,
    products: [
      { name: 'Гречка', nameEn: 'Buckwheat', emoji: '🌾' },
      { name: 'Рис', nameEn: 'Rice', emoji: '🍚' },
      { name: 'Овсянка', nameEn: 'Oatmeal', emoji: '🥣' },
      { name: 'Макароны', nameEn: 'Pasta', emoji: '🍝' },
      { name: 'Спагетти', nameEn: 'Spaghetti', emoji: '🍝' },
      { name: 'Мука', nameEn: 'Flour', emoji: '🌾' },
      { name: 'Перловка', nameEn: 'Pearl Barley', emoji: '🌾' },
      { name: 'Пшено', nameEn: 'Millet', emoji: '🌾' },
    ],
  },
  {
    name: 'Орехи и сухофрукты',
    nameEn: 'Nuts & Dried Fruits',
    emoji: '🥜',
    order: 14,
    products: [
      { name: 'Арахис', nameEn: 'Peanuts', emoji: '🥜' },
      { name: 'Миндаль', nameEn: 'Almonds', emoji: '🌰' },
      { name: 'Грецкий орех', nameEn: 'Walnuts', emoji: '🌰' },
      { name: 'Кешью', nameEn: 'Cashews', emoji: '🥜' },
      { name: 'Изюм', nameEn: 'Raisins', emoji: '🍇' },
      { name: 'Курага', nameEn: 'Dried Apricots', emoji: '🍑' },
      { name: 'Чернослив', nameEn: 'Prunes', emoji: '🫐' },
      { name: 'Финики', nameEn: 'Dates', emoji: '🌴' },
    ],
  },
  {
    name: 'Масла и соусы',
    nameEn: 'Oils & Sauces',
    emoji: '🫗',
    order: 15,
    products: [
      { name: 'Подсолнечное масло', nameEn: 'Sunflower Oil', emoji: '🫗' },
      { name: 'Оливковое масло', nameEn: 'Olive Oil', emoji: '🫒' },
      { name: 'Кетчуп', nameEn: 'Ketchup', emoji: '🍅' },
      { name: 'Майонез', nameEn: 'Mayonnaise', emoji: '🥚' },
      { name: 'Горчица', nameEn: 'Mustard', emoji: '🌭' },
      { name: 'Соевый соус', nameEn: 'Soy Sauce', emoji: '🍶' },
      { name: 'Уксус', nameEn: 'Vinegar', emoji: '🫗' },
      { name: 'Томатная паста', nameEn: 'Tomato Paste', emoji: '🍅' },
    ],
  },
  {
    name: 'Замороженные продукты',
    nameEn: 'Frozen',
    emoji: '🧊',
    order: 16,
    products: [
      { name: 'Пельмени', nameEn: 'Dumplings', emoji: '🥟' },
      { name: 'Вареники', nameEn: 'Vareniki', emoji: '🥟' },
      { name: 'Замороженные овощи', nameEn: 'Frozen Vegetables', emoji: '🥦' },
      { name: 'Замороженные ягоды', nameEn: 'Frozen Berries', emoji: '🫐' },
      { name: 'Пицца замороженная', nameEn: 'Frozen Pizza', emoji: '🍕' },
      { name: 'Мороженое', nameEn: 'Ice Cream', emoji: '🍦' },
    ],
  },
  {
    name: 'Рыба и морепродукты',
    nameEn: 'Fish & Seafood',
    emoji: '🐟',
    order: 17,
    products: [
      { name: 'Лосось', nameEn: 'Salmon', emoji: '🐟' },
      { name: 'Тунец', nameEn: 'Tuna', emoji: '🐟' },
      { name: 'Сельдь', nameEn: 'Herring', emoji: '🐟' },
      { name: 'Креветки', nameEn: 'Shrimp', emoji: '🍤' },
      { name: 'Кальмар', nameEn: 'Squid', emoji: '🦑' },
      { name: 'Мидии', nameEn: 'Mussels', emoji: '🦪' },
      { name: 'Краб', nameEn: 'Crab', emoji: '🦀' },
      { name: 'Икра', nameEn: 'Caviar', emoji: '🥚' },
    ],
  },
  {
    name: 'Детское питание',
    nameEn: 'Baby Food',
    emoji: '🍼',
    order: 18,
    products: [
      { name: 'Детская смесь', nameEn: 'Baby Formula', emoji: '🍼' },
      { name: 'Детское пюре', nameEn: 'Baby Puree', emoji: '🥫' },
      { name: 'Детская каша', nameEn: 'Baby Cereal', emoji: '🥣' },
      { name: 'Детское печенье', nameEn: 'Baby Cookies', emoji: '🍪' },
      { name: 'Детский сок', nameEn: 'Baby Juice', emoji: '🧃' },
    ],
  },
  {
    name: 'Корм для животных',
    nameEn: 'Pet Food',
    emoji: '🐾',
    order: 19,
    products: [
      { name: 'Корм для кошек', nameEn: 'Cat Food', emoji: '🐱' },
      { name: 'Корм для собак', nameEn: 'Dog Food', emoji: '🐶' },
      { name: 'Лакомства для кошек', nameEn: 'Cat Treats', emoji: '🐱' },
      { name: 'Лакомства для собак', nameEn: 'Dog Treats', emoji: '🐶' },
      { name: 'Наполнитель для туалета', nameEn: 'Cat Litter', emoji: '🐾' },
    ],
  },
];

type PrismaErrorLike = {
  code?: string;
  message?: string;
};

const isPrismaError = (value: unknown): value is PrismaErrorLike =>
  typeof value === 'object' && value !== null;

const usage = () => {
  console.log('Usage:');
  console.log('  npx tsx scripts/db-admin.ts <command>');
  console.log('');
  console.log('Available commands:');
  for (const command of commands) {
    console.log(`  - ${command}`);
  }
  console.log('');
  console.log('Flags:');
  console.log('  --dry-run  (only for cleanup-unused-images)');
};

async function verifyUsers() {
  const result = await prisma.user.updateMany({
    where: {
      emailVerified: null,
      password: { not: null },
    },
    data: {
      emailVerified: new Date(),
    },
  });

  console.log(`✅ Verified ${result.count} local users`);
}

async function reassignProducts() {
  for (const rule of reassignRules) {
    let category = await prisma.category.findUnique({
      where: { name: rule.categoryName },
    });

    if (!category) {
      category = await prisma.category.create({
        data: {
          name: rule.categoryName,
          nameEn: rule.categoryName,
          emoji: '🍬',
          order: 999,
        },
      });
      console.log(`➕ Created missing category: ${rule.categoryName}`);
    }

    const existingProducts = await prisma.product.findMany({
      where: { name: { in: rule.productNames } },
      select: { name: true },
    });

    const foundNames = new Set(existingProducts.map((p) => p.name));
    const missingNames = rule.productNames.filter((name) => !foundNames.has(name));

    const updateResult = await prisma.product.updateMany({
      where: { name: { in: rule.productNames } },
      data: { categoryId: category.id },
    });

    console.log(`✅ ${rule.categoryName}: moved ${updateResult.count} products to this category`);

    if (missingNames.length > 0) {
      console.log(`   Missing products: ${missingNames.join(', ')}`);
    }
  }
}

async function checkDatabase() {
  console.log('🔍 Checking database...\n');

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true },
  });

  console.log(`👤 Users: ${users.length}`);
  users.forEach((user) => {
    console.log(`  - ${user.name || 'No name'} (${user.email})`);
  });

  const categories = await prisma.category.findMany({
    select: { id: true, name: true, emoji: true },
    take: 3,
  });

  console.log(`\n📁 Categories: ${await prisma.category.count()}`);
  categories.forEach((cat) => {
    console.log(`  - ${cat.emoji} ${cat.name}`);
  });

  const result = await prisma.$queryRaw<{ server_encoding: string; client_encoding: string }[]>`
    SELECT
      current_setting('server_encoding') as server_encoding,
      current_setting('client_encoding') as client_encoding
  `;

  console.log(`\n🔤 Database encoding:`);
  console.log(`  Server: ${result[0].server_encoding}`);
  console.log(`  Client: ${result[0].client_encoding}`);
}

async function checkLists() {
  const lists = await prisma.list.findMany({
    include: {
      _count: { select: { items: true } },
      user: { select: { email: true } },
    },
  });

  console.log(`\nВсего списков в базе: ${lists.length}\n`);

  if (lists.length === 0) {
    console.log('❌ Списки не найдены!');
  } else {
    lists.forEach((list) => {
      console.log(`📋 ${list.name}`);
      console.log(`   ID: ${list.id}`);
      console.log(`   User: ${list.user.email}`);
      console.log(`   Items: ${list._count.items}`);
      console.log(`   Active: ${list.isActive}`);
      console.log('');
    });
  }
}

async function checkConstraint() {
  console.log('Checking unique constraint on items table...\n');

  try {
    const lists = await prisma.list.findMany();
    const products = await prisma.product.findMany({ take: 1 });

    if (lists.length === 0 || products.length === 0) {
      console.log('No lists or products found to test with');
      return;
    }

    const testList = lists[0];
    const testProduct = products[0];

    console.log(`Testing with list "${testList.name}" and product "${testProduct.name}"`);

    const item1 = await prisma.item.create({
      data: {
        listId: testList.id,
        productId: testProduct.id,
      },
    });
    console.log('✓ First item created:', item1.id);

    try {
      const item2 = await prisma.item.create({
        data: {
          listId: testList.id,
          productId: testProduct.id,
        },
      });
      console.log('✗ ERROR: Second item was created! Unique constraint is NOT working!', item2.id);
    } catch (error: unknown) {
      if (isPrismaError(error) && error.code === 'P2002') {
        console.log('✓ Unique constraint is working! Duplicate was rejected.');
      } else {
        const message = isPrismaError(error) ? error.message : 'Unknown error';
        console.log('✗ Unexpected error:', message);
      }
    }

    await prisma.item.delete({ where: { id: item1.id } });
    console.log('✓ Test item cleaned up');
  } catch (error: unknown) {
    const message = isPrismaError(error) ? error.message : 'Unknown error';
    console.error('Error during test:', message);
  }
}

async function checkDuplicates() {
  console.log('Checking for duplicate items in all lists...\n');

  const lists = await prisma.list.findMany({
    include: {
      items: {
        include: {
          product: {
            select: { name: true, emoji: true },
          },
        },
      },
    },
  });

  let totalDuplicates = 0;

  for (const list of lists) {
    console.log(`\nList: ${list.name} (ID: ${list.id})`);
    console.log(`Total items: ${list.items.length}`);

    const productCounts = new Map<string, typeof list.items>();

    for (const item of list.items) {
      if (!productCounts.has(item.productId)) {
        productCounts.set(item.productId, []);
      }
      productCounts.get(item.productId)!.push(item);
    }

    const duplicates = Array.from(productCounts.entries()).filter(([_, items]) => items.length > 1);

    if (duplicates.length > 0) {
      console.log(`\n⚠️  Found ${duplicates.length} products with duplicates:`);

      for (const [productId, items] of duplicates) {
        const product = items[0].product;
        console.log(`  ${product.emoji} ${product.name}: ${items.length} copies`);
        console.log(`    Item IDs: ${items.map((i) => i.id).join(', ')}`);
        totalDuplicates += items.length - 1;
      }
    } else {
      console.log('  ✓ No duplicates in this list');
    }
  }

  console.log(`\n\nTotal duplicate items found: ${totalDuplicates}`);

  if (totalDuplicates > 0) {
    console.log('\nTo remove duplicates, run: npx tsx scripts/db-admin.ts remove-duplicate-items');
  }
}

async function removeDuplicateItems() {
  console.log('Checking for duplicate items...');

  const items = await prisma.item.findMany({
    orderBy: [{ listId: 'asc' }, { productId: 'asc' }, { createdAt: 'asc' }],
  });

  const seen = new Map<string, string>();
  const duplicateIds: string[] = [];

  for (const item of items) {
    const key = `${item.listId}-${item.productId}`;
    if (seen.has(key)) {
      duplicateIds.push(item.id);
      console.log(
        `Found duplicate: listId=${item.listId}, productId=${item.productId}, itemId=${item.id}`
      );
    } else {
      seen.set(key, item.id);
    }
  }

  if (duplicateIds.length === 0) {
    console.log('No duplicates found!');
    return;
  }

  console.log(`\nFound ${duplicateIds.length} duplicate items. Removing them...`);

  const result = await prisma.item.deleteMany({
    where: {
      id: { in: duplicateIds },
    },
  });

  console.log(`Removed ${result.count} duplicate items.`);
}

async function removeDuplicateProducts() {
  console.log('🔍 Searching for duplicate products...\n');

  const allProducts = await prisma.product.findMany({
    orderBy: { createdAt: 'asc' },
  });

  console.log(`📊 Total products in database: ${allProducts.length}\n`);

  const seenByNameRu = new Map<string, string>();
  const seenByNameEn = new Map<string, string>();
  const toDelete: string[] = [];

  for (const product of allProducts) {
    let isDuplicate = false;

    if (seenByNameRu.has(product.name)) {
      const originalId = seenByNameRu.get(product.name)!;
      console.log(`❌ Duplicate found (by Russian name):`);
      console.log(`   Original: ${product.name} (ID: ${originalId})`);
      console.log(`   Duplicate: ${product.name} (ID: ${product.id})`);
      toDelete.push(product.id);
      isDuplicate = true;
    }

    if (seenByNameEn.has(product.nameEn)) {
      const originalId = seenByNameEn.get(product.nameEn)!;
      if (!isDuplicate) {
        console.log(`❌ Duplicate found (by English name):`);
        console.log(`   Original: ${product.nameEn} (ID: ${originalId})`);
        console.log(`   Duplicate: ${product.nameEn} (ID: ${product.id})`);
        toDelete.push(product.id);
        isDuplicate = true;
      }
    }

    if (!isDuplicate) {
      seenByNameRu.set(product.name, product.id);
      seenByNameEn.set(product.nameEn, product.id);
    }
  }

  console.log(`\n📊 Found ${toDelete.length} duplicate products\n`);

  if (toDelete.length === 0) {
    console.log('✅ No duplicates found. Database is clean!');
    return;
  }

  console.log('🗑️  Deleting duplicates...\n');

  const deleteResult = await prisma.product.deleteMany({
    where: { id: { in: toDelete } },
  });

  console.log(`✅ Deleted ${deleteResult.count} duplicate products\n`);

  const remainingProducts = await prisma.product.count();
  console.log(`📊 Remaining products: ${remainingProducts}`);
  console.log('🎉 Done!');
}

async function fixCategories() {
  console.log('🔧 Fixing categories - setting isCustom based on imageUrl...\n');

  const customResult = await prisma.category.updateMany({
    where: { imageUrl: { not: null } },
    data: { isCustom: true },
  });

  console.log(`✅ Set isCustom=true for ${customResult.count} categories with images`);

  const standardResult = await prisma.category.updateMany({
    where: { imageUrl: null },
    data: { isCustom: false },
  });

  console.log(`✅ Set isCustom=false for ${standardResult.count} standard emoji categories\n`);

  const categories = await prisma.category.findMany({
    select: { id: true, name: true, emoji: true, isCustom: true, imageUrl: true },
    orderBy: { order: 'asc' },
  });

  console.log('📋 Current categories:');
  categories.forEach((cat) => {
    console.log(
      `  ${cat.emoji} ${cat.name} - isCustom: ${cat.isCustom}, imageUrl: ${cat.imageUrl || 'none'}`
    );
  });
}

async function addNewCategories() {
  console.log('📦 Adding new categories...\n');

  for (const categoryData of newCategories) {
    const { products, ...categoryInfo } = categoryData;

    const existing = await prisma.category.findFirst({
      where: {
        OR: [{ nameEn: categoryInfo.nameEn }, { name: categoryInfo.name }],
      },
    });

    if (existing) {
      console.log(`⏭️  Skipping ${categoryInfo.emoji} ${categoryInfo.name} - already exists`);
      continue;
    }

    const category = await prisma.category.create({
      data: {
        ...categoryInfo,
        products: {
          create: products.map((product) => ({
            ...product,
            isCustom: false,
          })),
        },
      },
    });

    console.log(`✅ Created ${category.emoji} ${category.name} with ${products.length} products`);
  }

  const totalCategories = await prisma.category.count();
  const totalProducts = await prisma.product.count();

  console.log('\n🎉 Done!');
  console.log(`📊 Total categories: ${totalCategories}`);
  console.log(`📊 Total products: ${totalProducts}`);
}

async function addNoteColumn() {
  console.log('🔧 Adding note column to items table...');

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "items"
    ADD COLUMN IF NOT EXISTS "note" TEXT;
  `);

  console.log('✅ Column "note" added successfully (or already exists)');

  const result = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'items'
    ORDER BY ordinal_position;
  `;

  console.log('\n📋 Current columns in "items" table:');
  result.forEach((col) => console.log(`  - ${col.column_name}`));
}

async function importProducts() {
  console.log('📦 Starting bulk product import...\n');

  const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ GOOGLE_GENAI_API_KEY or GEMINI_API_KEY not found in environment variables');
    process.exit(1);
  }

  const inputPath = join(process.cwd(), 'scripts', 'products-input.json');
  let productNames: string[];

  try {
    const rawData = readFileSync(inputPath, 'utf-8');
    productNames = JSON.parse(rawData);

    if (!Array.isArray(productNames)) {
      console.error('❌ products-input.json must contain an array of product names');
      process.exit(1);
    }

    console.log(`📝 Found ${productNames.length} products to import\n`);
  } catch {
    console.error('❌ Failed to read products-input.json');
    console.error('   Create the file with format: ["product1", "product2", ...]');
    process.exit(1);
  }

  const categories = await prisma.category.findMany({
    select: { id: true, name: true, nameEn: true },
  });

  if (categories.length === 0) {
    console.error('❌ No categories found in database. Please run seed first: npx prisma db seed');
    process.exit(1);
  }

  console.log(`📚 Found ${categories.length} categories in database\n`);

  const genAI = new GoogleGenAI({ apiKey });
  const categoriesStr = categories.map((c) => `${c.nameEn} (${c.name})`).join(', ');

  const prompt = `You are a grocery categorization assistant. Given a list of product names, translate them to Russian and English, assign them to the most appropriate category, and suggest a Unicode emoji if one exists.

Available categories: ${categoriesStr}

Rules:
1. Translate each product name to both Russian (nameRu) and English (nameEn)
2. Assign each product to the MOST appropriate category from the list above
3. Suggest a single Unicode emoji that represents the product (e.g., 🍎 for apple)
4. If NO suitable emoji exists, use an empty string ""
5. Be precise with categories - use exact names from the list

Input products:
${productNames.map((name, i) => `${i + 1}. ${name}`).join('\n')}

Respond ONLY with valid JSON array in this exact format:
[
  {
    "nameRu": "Яблоко",
    "nameEn": "Apple",
    "categoryName": "Fruits",
    "emoji": "🍎"
  }
]`;

  console.log('🤖 Processing products with Gemini AI...\n');

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });
  const responseText = result.text;

  if (!responseText) {
    throw new Error('No response from AI');
  }

  let jsonStr = responseText.trim();
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```\n?/g, '').trim();
  }

  jsonStr = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ' ');

  const processedProducts: Array<{
    nameRu: string;
    nameEn: string;
    categoryName: string;
    emoji: string;
  }> = JSON.parse(jsonStr);

  console.log(`✅ AI processed ${processedProducts.length} products\n`);

  let successCount = 0;
  let skipCount = 0;

  for (const product of processedProducts) {
    const category = categories.find(
      (c) => c.nameEn === product.categoryName || c.name === product.categoryName
    );

    if (!category) {
      console.warn(
        `⚠️  Skipping "${product.nameRu}" - category "${product.categoryName}" not found`
      );
      skipCount++;
      continue;
    }

    const existingProduct = await prisma.product.findFirst({
      where: { OR: [{ name: product.nameRu }, { nameEn: product.nameEn }] },
    });

    if (existingProduct) {
      console.log(`  ⏭️  ${product.nameRu} (${product.nameEn}) - already exists, skipping`);
      skipCount++;
      continue;
    }

    try {
      await prisma.product.create({
        data: {
          name: product.nameRu,
          nameEn: product.nameEn,
          emoji: product.emoji || '📦',
          categoryId: category.id,
          isCustom: false,
          imageUrl: null,
        },
      });

      const emojiDisplay = product.emoji || '❌';
      console.log(`  ✅ ${emojiDisplay} ${product.nameRu} (${product.nameEn}) → ${category.name}`);
      successCount++;
    } catch (error) {
      console.error(`  ❌ Failed to create "${product.nameRu}":`, error);
      skipCount++;
    }
  }

  console.log('\n🎉 Import completed!');
  console.log(`   ✅ Successfully imported: ${successCount}`);
  if (skipCount > 0) {
    console.log(`   ⚠️  Skipped: ${skipCount}`);
  }
}

async function createAdmin() {
  console.log('👤 Creating admin user...\n');

  const email = 'admin@clickmoji.com';
  const password = 'admin123';
  const name = 'Admin';

  const existingAdmin = await prisma.user.findUnique({ where: { email } });

  if (existingAdmin) {
    console.log('⚠️  Admin user already exists:', email);
    console.log('Updating role to ADMIN...\n');

    await prisma.user.update({
      where: { email },
      data: { role: 'ADMIN', emailVerified: new Date() },
    });

    console.log('✅ User role updated to ADMIN');
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.create({
    data: {
      email,
      name,
      password: hashedPassword,
      role: 'ADMIN',
      emailVerified: new Date(),
    },
  });

  console.log('✅ Admin user created successfully!\n');
  console.log('📧 Email:', email);
  console.log('🔑 Password:', password);
  console.log('\n⚠️  IMPORTANT: Change this password after first login!\n');
}

async function createTestUser() {
  console.log('👤 Creating test user...\n');

  const email = 'test@example.com';
  const password = 'test123';
  const name = 'Test User';

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log('✅ User already exists:');
    console.log(`   Email: ${email}`);
    console.log(`   Password: test123`);
    console.log('\n💡 You can login with these credentials');
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      name,
      emailVerified: new Date(),
    },
  });

  console.log('✅ Test user created successfully!\n');
  console.log('📋 Login credentials:');
  console.log(`   Email: ${email}`);
  console.log(`   Password: ${password}`);
  console.log('\n💡 Use these to login at http://localhost:3000/login');
}

async function exportNeon() {
  console.log('📦 Exporting data from Neon database...');

  const categories = await prisma.category.findMany({
    include: { products: true },
    orderBy: { order: 'asc' },
  });

  const exportData = {
    categories: categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      nameEn: cat.nameEn,
      emoji: cat.emoji,
      order: cat.order,
      isCustom: cat.isCustom,
      imageUrl: cat.imageUrl,
      products: cat.products.map((prod) => ({
        id: prod.id,
        name: prod.name,
        nameEn: prod.nameEn,
        emoji: prod.emoji,
        isCustom: prod.isCustom,
        imageUrl: prod.imageUrl,
      })),
    })),
  };

  const exportPath = join(process.cwd(), 'neon-export.json');
  writeFileSync(exportPath, JSON.stringify(exportData, null, 2));

  console.log(`✅ Exported ${categories.length} categories`);
  console.log(
    `✅ Exported ${categories.reduce((sum, cat) => sum + cat.products.length, 0)} products`
  );
  console.log(`📁 Saved to: ${exportPath}`);
}

async function importToLocal() {
  console.log('📦 Importing data to local database...');

  const exportPath = join(process.cwd(), 'neon-export.json');

  if (!existsSync(exportPath)) {
    console.error('❌ Export file not found: neon-export.json');
    console.log('💡 Run: npx tsx scripts/db-admin.ts export-neon first');
    process.exit(1);
  }

  const exportData = JSON.parse(readFileSync(exportPath, 'utf-8'));

  console.log(`📋 Found ${exportData.categories.length} categories to import`);

  console.log('🧹 Cleaning existing data...');
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});

  for (const categoryData of exportData.categories) {
    const { products, ...categoryInfo } = categoryData;

    console.log(`📁 Importing category: ${categoryInfo.emoji} ${categoryInfo.name}`);

    await prisma.category.create({
      data: {
        ...categoryInfo,
        products: { create: products },
      },
    });

    console.log(`  ✅ Imported ${products.length} products`);
  }

  const totalCategories = await prisma.category.count();
  const totalProducts = await prisma.product.count();

  console.log('\n🎉 Import completed!');
  console.log(`📊 Total categories: ${totalCategories}`);
  console.log(`📊 Total products: ${totalProducts}`);
}

async function migrateData() {
  const localDb = new PrismaClient({
    datasources: {
      db: {
        url: 'postgresql://postgres:postgres@localhost:5432/clickmoji_shop?schema=public',
      },
    },
  });

  const productionDb = new PrismaClient({
    datasources: {
      db: {
        url: 'postgresql://neondb_owner:npg_YxyufN96DJmS@ep-muddy-paper-af7zs84y-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require',
      },
    },
  });

  try {
    console.log('🚀 Starting data migration...\n');
    console.log('⚠️  WARNING: This will REPLACE all data in production!\n');

    console.log('📦 Fetching categories from local DB...');
    const localCategories = await localDb.category.findMany({
      include: { products: true },
      orderBy: { order: 'asc' },
    });
    console.log(`   Found ${localCategories.length} categories\n`);

    console.log('🗑️  Cleaning production DB...');
    await productionDb.product.deleteMany({});
    await productionDb.category.deleteMany({});
    console.log('   Cleaned!\n');

    console.log('📤 Migrating data to production...\n');

    for (const category of localCategories) {
      console.log(`   📁 Category: ${category.emoji} ${category.name}`);

      const newCategory = await productionDb.category.create({
        data: {
          name: category.name,
          nameEn: category.nameEn,
          emoji: category.emoji,
          isCustom: category.isCustom,
          imageUrl: category.imageUrl,
          order: category.order,
        },
      });

      if (category.products.length > 0) {
        for (const product of category.products) {
          await productionDb.product.create({
            data: {
              name: product.name,
              nameEn: product.nameEn,
              emoji: product.emoji,
              isCustom: product.isCustom,
              imageUrl: product.imageUrl,
              categoryId: newCategory.id,
            },
          });
        }
        console.log(`      ✅ Migrated ${category.products.length} products`);
      }
    }

    console.log('\n📊 Migration complete!\n');
    const categoriesCount = await productionDb.category.count();
    const productsCount = await productionDb.product.count();
    console.log(`   Categories: ${categoriesCount}`);
    console.log(`   Products: ${productsCount}\n`);

    console.log('✅ Success! Data migrated to production.\n');
    console.log('⚠️  Remember: This is a ONE-TIME operation!');
    console.log('   In the future, manage production data through the admin panel.\n');
  } finally {
    await localDb.$disconnect();
    await productionDb.$disconnect();
  }
}

function getFileKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    return pathParts[pathParts.length - 1] || null;
  } catch {
    return null;
  }
}

async function cleanupOrphanedFiles() {
  const utapi = new UTApi();
  console.log('🧹 Starting orphaned files cleanup...\n');

  const { files } = await utapi.listFiles();

  if (!files || files.length === 0) {
    console.log('✅ No files found in UploadThing');
    return;
  }

  console.log(`📦 Found ${files.length} files in UploadThing\n`);

  console.log('🔍 Checking database for used images...');
  const [products, categories] = await Promise.all([
    prisma.product.findMany({
      where: { imageUrl: { not: null } },
      select: { imageUrl: true },
    }),
    prisma.category.findMany({
      where: { imageUrl: { not: null } },
      select: { imageUrl: true },
    }),
  ]);

  const usedFileKeys = new Set<string>();

  products.forEach((product) => {
    const fileKey = getFileKeyFromUrl(product.imageUrl);
    if (fileKey) usedFileKeys.add(fileKey);
  });

  categories.forEach((category) => {
    const fileKey = getFileKeyFromUrl(category.imageUrl);
    if (fileKey) usedFileKeys.add(fileKey);
  });

  console.log(`✅ Found ${usedFileKeys.size} files currently in use\n`);

  const orphanedFiles: string[] = [];

  files.forEach((file) => {
    if (!usedFileKeys.has(file.key)) {
      orphanedFiles.push(file.key);
    }
  });

  if (orphanedFiles.length === 0) {
    console.log('✨ No orphaned files found. Everything is clean!\n');
    return;
  }

  console.log(`🗑️  Found ${orphanedFiles.length} orphaned files:\n`);
  orphanedFiles.forEach((key, index) => {
    console.log(`  ${index + 1}. ${key}`);
  });

  console.log('\n⚠️  These files will be PERMANENTLY deleted from UploadThing.');
  console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log('🗑️  Deleting orphaned files...\n');

  await utapi.deleteFiles(orphanedFiles);
  console.log(`✅ Successfully deleted ${orphanedFiles.length} orphaned files!\n`);
  console.log('🎉 Cleanup completed successfully!');
}

async function cleanupUnusedImages(isDryRun: boolean) {
  const utapi = new UTApi();

  if (isDryRun) {
    console.log('🔍 Running in DRY-RUN mode (no files will be deleted)\n');
  } else {
    console.log('🧹 Starting cleanup of unused images...\n');
  }

  console.log('📊 Fetching used images from database...');

  const categories = await prisma.category.findMany({
    where: { isCustom: true, imageUrl: { not: null } },
    select: { imageUrl: true },
  });

  const products = await prisma.product.findMany({
    where: { isCustom: true, imageUrl: { not: null } },
    select: { imageUrl: true },
  });

  const usedUrls = new Set<string>();
  categories.forEach((cat) => {
    if (cat.imageUrl) usedUrls.add(cat.imageUrl);
  });
  products.forEach((prod) => {
    if (prod.imageUrl) usedUrls.add(prod.imageUrl);
  });

  console.log(`✅ Found ${usedUrls.size} images in use`);
  console.log(`   - Categories: ${categories.length}`);
  console.log(`   - Products: ${products.length}\n`);

  const usedFileKeys = new Set<string>();
  usedUrls.forEach((url) => {
    const fileKey = url.split('/f/')[1];
    if (fileKey) usedFileKeys.add(fileKey);
  });

  console.log(`🔑 Extracted ${usedFileKeys.size} file keys from URLs\n`);

  console.log('☁️  Fetching files from UploadThing...');
  const uploadThingFiles = await utapi.listFiles();

  if (!uploadThingFiles.files || uploadThingFiles.files.length === 0) {
    console.log('ℹ️  No files found in UploadThing storage');
    return;
  }

  console.log(`✅ Found ${uploadThingFiles.files.length} files in UploadThing\n`);

  const unusedFiles = uploadThingFiles.files.filter((file) => !usedFileKeys.has(file.key));

  if (unusedFiles.length === 0) {
    console.log('✨ No unused files found. Storage is clean!');
    return;
  }

  console.log(`🗑️  Found ${unusedFiles.length} unused files:\n`);

  unusedFiles.forEach((file, index) => {
    const uploadDate = new Date(file.uploadedAt).toLocaleDateString('ru-RU');
    const sizeKB = (file.size / 1024).toFixed(2);
    console.log(`   ${index + 1}. ${file.name}`);
    console.log(`      Key: ${file.key}`);
    console.log(`      Size: ${sizeKB} KB`);
    console.log(`      Uploaded: ${uploadDate}\n`);
  });

  const totalSize = unusedFiles.reduce((sum, file) => sum + file.size, 0);
  const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);
  console.log(`📦 Total size to free: ${totalSizeMB} MB\n`);

  if (isDryRun) {
    console.log('ℹ️  DRY-RUN: Files that WOULD be deleted:\n');
    console.log(`   - Would delete: ${unusedFiles.length} files`);
    console.log(`   - Would free: ${totalSizeMB} MB`);
    console.log(`   - Remaining in use: ${usedFileKeys.size} files\n`);
    console.log('💡 Run without --dry-run to actually delete these files');
    console.log('   Command: npm run cleanup-images');
  } else {
    console.log('🗑️  Deleting unused files...\n');

    const fileKeysToDelete = unusedFiles.map((file) => file.key);
    const batchSize = 10;
    let deletedCount = 0;

    for (let i = 0; i < fileKeysToDelete.length; i += batchSize) {
      const batch = fileKeysToDelete.slice(i, i + batchSize);

      try {
        await utapi.deleteFiles(batch);
        deletedCount += batch.length;
        console.log(`   Deleted ${deletedCount}/${fileKeysToDelete.length} files...`);
      } catch (error) {
        console.error(`   ❌ Error deleting batch ${i / batchSize + 1}:`, error);
      }
    }

    console.log(`\n✅ Cleanup completed!`);
    console.log(`   - Deleted: ${deletedCount} files`);
    console.log(`   - Freed: ${totalSizeMB} MB`);
    console.log(`   - Remaining in use: ${usedFileKeys.size} files`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const isDryRun = rest.includes('--dry-run');

  if (!command || !commands.includes(command as Command)) {
    usage();
    process.exit(command ? 1 : 0);
  }

  switch (command as Command) {
    case 'verify-users':
      await verifyUsers();
      break;
    case 'reassign-products':
      await reassignProducts();
      break;
    case 'check-db':
      await checkDatabase();
      break;
    case 'check-lists':
      await checkLists();
      break;
    case 'check-constraint':
      await checkConstraint();
      break;
    case 'check-duplicates':
      await checkDuplicates();
      break;
    case 'remove-duplicate-items':
      await removeDuplicateItems();
      break;
    case 'remove-duplicate-products':
      await removeDuplicateProducts();
      break;
    case 'fix-categories':
      await fixCategories();
      break;
    case 'add-new-categories':
      await addNewCategories();
      break;
    case 'add-note-column':
      await addNoteColumn();
      break;
    case 'import-products':
      await importProducts();
      break;
    case 'create-admin':
      await createAdmin();
      break;
    case 'create-test-user':
      await createTestUser();
      break;
    case 'export-neon':
      await exportNeon();
      break;
    case 'import-to-local':
      await importToLocal();
      break;
    case 'migrate-data':
      await migrateData();
      break;
    case 'cleanup-orphaned-files':
      await cleanupOrphanedFiles();
      break;
    case 'cleanup-unused-images':
      await cleanupUnusedImages(isDryRun);
      break;
  }
}

main()
  .catch((error) => {
    console.error('DB admin error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
