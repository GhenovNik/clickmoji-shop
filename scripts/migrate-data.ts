/**
 * ONE-TIME DATA MIGRATION SCRIPT
 *
 * Переносит данные из локальной БД в production.
 *
 * ⚠️ ВНИМАНИЕ:
 * - Используйте ТОЛЬКО для первоначального заполнения production
 * - НЕ используйте регулярно!
 * - Существующие данные в production будут перезаписаны
 *
 * Usage:
 * 1. Убедитесь, что локальная БД содержит нужные данные
 * 2. npm run migrate-data
 */

import { PrismaClient } from '@prisma/client';

// Локальная БД
const localDb = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres:postgres@localhost:5432/clickmoji_shop?schema=public',
    },
  },
});

// Production БД (Neon)
const productionDb = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://neondb_owner:npg_YxyufN96DJmS@ep-muddy-paper-af7zs84y-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require',
    },
  },
});

async function main() {
  console.log('🚀 Starting data migration...\n');
  console.log('⚠️  WARNING: This will REPLACE all data in production!\n');

  // Confirmation (можно раскомментировать для безопасности)
  // const readline = require('readline').createInterface({
  //   input: process.stdin,
  //   output: process.stdout
  // });
  // const answer = await new Promise(resolve => {
  //   readline.question('Type "YES" to continue: ', resolve);
  // });
  // readline.close();
  // if (answer !== 'YES') {
  //   console.log('Migration cancelled.');
  //   return;
  // }

  try {
    // 1. Получаем категории из локальной БД
    console.log('📦 Fetching categories from local DB...');
    const localCategories = await localDb.category.findMany({
      include: {
        products: true,
      },
      orderBy: {
        order: 'asc',
      },
    });
    console.log(`   Found ${localCategories.length} categories\n`);

    // 2. Очищаем production БД
    console.log('🗑️  Cleaning production DB...');
    await productionDb.product.deleteMany({});
    await productionDb.category.deleteMany({});
    console.log('   Cleaned!\n');

    // 3. Копируем категории и продукты
    console.log('📤 Migrating data to production...\n');

    for (const category of localCategories) {
      console.log(`   📁 Category: ${category.emoji} ${category.name}`);

      // Создаём категорию
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

      // Копируем продукты
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

    // 4. Статистика
    console.log('\n📊 Migration complete!\n');
    const categoriesCount = await productionDb.category.count();
    const productsCount = await productionDb.product.count();
    console.log(`   Categories: ${categoriesCount}`);
    console.log(`   Products: ${productsCount}\n`);

    console.log('✅ Success! Data migrated to production.\n');
    console.log('⚠️  Remember: This is a ONE-TIME operation!');
    console.log('   In the future, manage production data through the admin panel.\n');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await localDb.$disconnect();
    await productionDb.$disconnect();
  });
