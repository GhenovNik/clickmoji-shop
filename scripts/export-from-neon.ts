import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('📦 Exporting data from Neon database...');

  // Экспортируем категории с товарами
  const categories = await prisma.category.findMany({
    include: {
      products: true,
    },
    orderBy: {
      order: 'asc',
    },
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

  const exportPath = path.join(process.cwd(), 'neon-export.json');
  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));

  console.log(`✅ Exported ${categories.length} categories`);
  console.log(
    `✅ Exported ${categories.reduce((sum, cat) => sum + cat.products.length, 0)} products`
  );
  console.log(`📁 Saved to: ${exportPath}`);
}

main()
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
