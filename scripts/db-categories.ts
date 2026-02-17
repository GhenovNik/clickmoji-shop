import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(),
});

type Command = 'fix-categories' | 'add-new-categories';

const commands: Command[] = ['fix-categories', 'add-new-categories'];

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

const usage = () => {
  console.log('Usage:');
  console.log('  npx tsx scripts/db-categories.ts <command>');
  console.log('');
  console.log('Available commands:');
  commands.forEach((command) => console.log(`  - ${command}`));
};

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

async function main() {
  const command = process.argv[2] as Command | undefined;

  if (!command || !commands.includes(command)) {
    usage();
    process.exit(command ? 1 : 0);
  }

  if (command === 'fix-categories') {
    await fixCategories();
  } else if (command === 'add-new-categories') {
    await addNewCategories();
  }
}

main()
  .catch((error) => {
    console.error('DB categories error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
