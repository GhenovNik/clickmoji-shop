import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('📦 Importing data to local database...');

  const exportPath = path.join(process.cwd(), 'neon-export.json');

  if (!fs.existsSync(exportPath)) {
    console.error('❌ Export file not found: neon-export.json');
    console.log('💡 Run: npx tsx scripts/export-from-neon.ts first');
    process.exit(1);
  }

  const exportData = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));

  console.log(`📋 Found ${exportData.categories.length} categories to import`);

  // Очищаем существующие данные
  console.log('🧹 Cleaning existing data...');
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});

  // Импортируем категории и товары
  for (const categoryData of exportData.categories) {
    const { products, ...categoryInfo } = categoryData;

    console.log(`📁 Importing category: ${categoryInfo.emoji} ${categoryInfo.name}`);

    await prisma.category.create({
      data: {
        ...categoryInfo,
        products: {
          create: products,
        },
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

main()
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
