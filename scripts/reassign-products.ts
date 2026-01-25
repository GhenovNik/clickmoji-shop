import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type ReassignRule = {
  categoryName: string;
  productNames: string[];
};

const rules: ReassignRule[] = [
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

async function main() {
  for (const rule of rules) {
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
      select: { id: true, name: true, categoryId: true },
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

main()
  .catch((error) => {
    console.error('Reassign error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
