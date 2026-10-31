import { PrismaClient } from '@prisma/client';
import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import { resolveGoogleTextModel } from '../src/lib/services/google-text-model';

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(),
});

type Command = 'reassign' | 'remove-duplicate-products' | 'import';

const commands: Command[] = ['reassign', 'remove-duplicate-products', 'import'];

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

const usage = () => {
  console.log('Usage:');
  console.log('  npx tsx scripts/db-products.ts <command>');
  console.log('');
  console.log('Available commands:');
  commands.forEach((command) => console.log(`  - ${command}`));
};

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

  const model = resolveGoogleTextModel();
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
    model,
    contents: prompt,
    config: { responseMimeType: 'application/json' },
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

async function main() {
  const command = process.argv[2] as Command | undefined;

  if (!command || !commands.includes(command)) {
    usage();
    process.exit(command ? 1 : 0);
  }

  if (command === 'reassign') {
    await reassignProducts();
  } else if (command === 'remove-duplicate-products') {
    await removeDuplicateProducts();
  } else if (command === 'import') {
    await importProducts();
  }
}

main()
  .catch((error) => {
    console.error('DB products error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
