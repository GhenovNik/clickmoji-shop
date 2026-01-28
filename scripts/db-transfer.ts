import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

type Command = 'export-neon' | 'import-to-local' | 'migrate-data';

const commands: Command[] = ['export-neon', 'import-to-local', 'migrate-data'];

const usage = () => {
  console.log('Usage:');
  console.log('  npx tsx scripts/db-transfer.ts <command>');
  console.log('');
  console.log('Available commands:');
  commands.forEach((command) => console.log(`  - ${command}`));
};

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
    console.log('💡 Run: npx tsx scripts/db-transfer.ts export-neon first');
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

async function main() {
  const command = process.argv[2] as Command | undefined;

  if (!command || !commands.includes(command)) {
    usage();
    process.exit(command ? 1 : 0);
  }

  if (command === 'export-neon') {
    await exportNeon();
  } else if (command === 'import-to-local') {
    await importToLocal();
  } else if (command === 'migrate-data') {
    await migrateData();
  }
}

main()
  .catch((error) => {
    console.error('DB transfer error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
