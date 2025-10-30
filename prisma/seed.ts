import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seed...');

  // Очистка существующих данных (в порядке зависимостей)
  await prisma.favorite.deleteMany();
  await prisma.item.deleteMany();
  await prisma.list.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();

  console.log('🧹 Cleaned existing data');

  // Создание категорий и продуктов
  const categories = [
    {
      name: 'Овощи',
      nameEn: 'Vegetables',
      emoji: '🥬',
      order: 1,
      products: [
        { name: 'Помидор', nameEn: 'Tomato', emoji: '🍅' },
        { name: 'Огурец', nameEn: 'Cucumber', emoji: '🥒' },
        { name: 'Морковь', nameEn: 'Carrot', emoji: '🥕' },
        { name: 'Лук', nameEn: 'Onion', emoji: '🧅' },
        { name: 'Чеснок', nameEn: 'Garlic', emoji: '🧄' },
        { name: 'Картофель', nameEn: 'Potato', emoji: '🥔' },
        { name: 'Перец чили', nameEn: 'Chili Pepper', emoji: '🌶️' },
        { name: 'Болгарский перец', nameEn: 'Bell Pepper', emoji: '🫑' },
        { name: 'Брокколи', nameEn: 'Broccoli', emoji: '🥦' },
        { name: 'Капуста', nameEn: 'Cabbage', emoji: '🥬' },
        { name: 'Салат', nameEn: 'Lettuce', emoji: '🥗' },
        { name: 'Кукуруза', nameEn: 'Corn', emoji: '🌽' },
        { name: 'Баклажан', nameEn: 'Eggplant', emoji: '🍆' },
        { name: 'Горох', nameEn: 'Peas', emoji: '🫛' },
      ],
    },
    {
      name: 'Фрукты',
      nameEn: 'Fruits',
      emoji: '🍎',
      order: 2,
      products: [
        { name: 'Яблоко', nameEn: 'Apple', emoji: '🍎' },
        { name: 'Банан', nameEn: 'Banana', emoji: '🍌' },
        { name: 'Апельсин', nameEn: 'Orange', emoji: '🍊' },
        { name: 'Лимон', nameEn: 'Lemon', emoji: '🍋' },
        { name: 'Виноград', nameEn: 'Grapes', emoji: '🍇' },
        { name: 'Клубника', nameEn: 'Strawberry', emoji: '🍓' },
        { name: 'Персик', nameEn: 'Peach', emoji: '🍑' },
        { name: 'Вишня', nameEn: 'Cherry', emoji: '🍒' },
        { name: 'Арбуз', nameEn: 'Watermelon', emoji: '🍉' },
        { name: 'Ананас', nameEn: 'Pineapple', emoji: '🍍' },
        { name: 'Киви', nameEn: 'Kiwi', emoji: '🥝' },
        { name: 'Манго', nameEn: 'Mango', emoji: '🥭' },
        { name: 'Груша', nameEn: 'Pear', emoji: '🍐' },
        { name: 'Черника', nameEn: 'Blueberry', emoji: '🫐' },
      ],
    },
    {
      name: 'Молочные продукты',
      nameEn: 'Dairy',
      emoji: '🥛',
      order: 3,
      products: [
        { name: 'Молоко', nameEn: 'Milk', emoji: '🥛' },
        { name: 'Масло сливочное', nameEn: 'Butter', emoji: '🧈' },
        { name: 'Сыр', nameEn: 'Cheese', emoji: '🧀' },
        { name: 'Яйца', nameEn: 'Eggs', emoji: '🥚' },
        { name: 'Мороженое', nameEn: 'Ice Cream', emoji: '🍦' },
        { name: 'Йогурт', nameEn: 'Yogurt', emoji: '🧃' },
        { name: 'Сметана', nameEn: 'Sour Cream', emoji: '🥄' },
        { name: 'Творог', nameEn: 'Cottage Cheese', emoji: '🫕' },
      ],
    },
    {
      name: 'Хлеб и выпечка',
      nameEn: 'Bread & Bakery',
      emoji: '🍞',
      order: 4,
      products: [
        { name: 'Хлеб белый', nameEn: 'White Bread', emoji: '🍞' },
        { name: 'Багет', nameEn: 'Baguette', emoji: '🥖' },
        { name: 'Бублик', nameEn: 'Bagel', emoji: '🥯' },
        { name: 'Круассан', nameEn: 'Croissant', emoji: '🥐' },
        { name: 'Крендель', nameEn: 'Pretzel', emoji: '🥨' },
        { name: 'Кекс', nameEn: 'Cupcake', emoji: '🧁' },
        { name: 'Торт', nameEn: 'Cake', emoji: '🍰' },
        { name: 'Блины', nameEn: 'Pancakes', emoji: '🥞' },
        { name: 'Вафли', nameEn: 'Waffles', emoji: '🧇' },
      ],
    },
    {
      name: 'Мясо и рыба',
      nameEn: 'Meat & Fish',
      emoji: '🥩',
      order: 5,
      products: [
        { name: 'Стейк', nameEn: 'Steak', emoji: '🥩' },
        { name: 'Курица', nameEn: 'Chicken', emoji: '🍗' },
        { name: 'Бекон', nameEn: 'Bacon', emoji: '🥓' },
        { name: 'Сосиски', nameEn: 'Hot Dog', emoji: '🌭' },
        { name: 'Мясо на кости', nameEn: 'Meat on Bone', emoji: '🍖' },
        { name: 'Рыба', nameEn: 'Fish', emoji: '🐟' },
        { name: 'Креветки', nameEn: 'Shrimp', emoji: '🍤' },
        { name: 'Лобстер', nameEn: 'Lobster', emoji: '🦞' },
        { name: 'Краб', nameEn: 'Crab', emoji: '🦀' },
        { name: 'Осьминог', nameEn: 'Octopus', emoji: '🐙' },
      ],
    },
    {
      name: 'Консервы и готовая еда',
      nameEn: 'Canned & Ready Food',
      emoji: '🥫',
      order: 6,
      products: [
        { name: 'Консервы', nameEn: 'Canned Food', emoji: '🥫' },
        { name: 'Паста', nameEn: 'Pasta', emoji: '🍝' },
        { name: 'Пицца', nameEn: 'Pizza', emoji: '🍕' },
        { name: 'Бургер', nameEn: 'Burger', emoji: '🍔' },
        { name: 'Тако', nameEn: 'Taco', emoji: '🌮' },
        { name: 'Буррито', nameEn: 'Burrito', emoji: '🌯' },
        { name: 'Шаурма', nameEn: 'Shawarma', emoji: '🥙' },
        { name: 'Лапша', nameEn: 'Noodles', emoji: '🍜' },
        { name: 'Суп', nameEn: 'Soup', emoji: '🍲' },
        { name: 'Салат готовый', nameEn: 'Ready Salad', emoji: '🥗' },
        { name: 'Бенто', nameEn: 'Bento Box', emoji: '🍱' },
      ],
    },
    {
      name: 'Напитки',
      nameEn: 'Beverages',
      emoji: '🍷',
      order: 7,
      products: [
        // Алкогольные
        { name: 'Вино', nameEn: 'Wine', emoji: '🍷' },
        { name: 'Пиво', nameEn: 'Beer', emoji: '🍺' },
        { name: 'Шампанское', nameEn: 'Champagne', emoji: '🍾' },
        { name: 'Виски', nameEn: 'Whiskey', emoji: '🥃' },
        { name: 'Коктейль', nameEn: 'Cocktail', emoji: '🍸' },
        // Безалкогольные
        { name: 'Вода', nameEn: 'Water', emoji: '💧' },
        { name: 'Кофе', nameEn: 'Coffee', emoji: '☕' },
        { name: 'Чай', nameEn: 'Tea', emoji: '🍵' },
        { name: 'Сок', nameEn: 'Juice', emoji: '🧃' },
        { name: 'Газировка', nameEn: 'Soda', emoji: '🥤' },
        { name: 'Bubble Tea', nameEn: 'Bubble Tea', emoji: '🧋' },
      ],
    },
    {
      name: 'Бытовая химия',
      nameEn: 'Household Chemicals',
      emoji: '🧴',
      order: 8,
      products: [
        { name: 'Моющее средство', nameEn: 'Detergent', emoji: '🧴' },
        { name: 'Губка', nameEn: 'Sponge', emoji: '🧽' },
        { name: 'Веник', nameEn: 'Broom', emoji: '🧹' },
        { name: 'Корзина для белья', nameEn: 'Laundry Basket', emoji: '🧺' },
        { name: 'Ведро', nameEn: 'Bucket', emoji: '🪣' },
        { name: 'Мыло', nameEn: 'Soap', emoji: '🧼' },
        { name: 'Пена для ванны', nameEn: 'Bubble Bath', emoji: '🫧' },
        { name: 'Туалетная бумага', nameEn: 'Toilet Paper', emoji: '🧻' },
        { name: 'Чистящее средство', nameEn: 'Cleaning Agent', emoji: '🧪' },
      ],
    },
    {
      name: 'Товары для дома',
      nameEn: 'Home Goods',
      emoji: '🧻',
      order: 9,
      products: [
        { name: 'Свечи', nameEn: 'Candles', emoji: '🕯️' },
        { name: 'Лампочка', nameEn: 'Light Bulb', emoji: '💡' },
        { name: 'Батарейки', nameEn: 'Batteries', emoji: '🔋' },
        { name: 'Коробка', nameEn: 'Box', emoji: '📦' },
        { name: 'Подарочная упаковка', nameEn: 'Gift Wrap', emoji: '🎁' },
        { name: 'Игрушка', nameEn: 'Toy', emoji: '🧸' },
        { name: 'Растение', nameEn: 'Plant', emoji: '🪴' },
        { name: 'Бритва', nameEn: 'Razor', emoji: '🪒' },
      ],
    },
    {
      name: 'Аптека',
      nameEn: 'Pharmacy',
      emoji: '💊',
      order: 10,
      products: [
        { name: 'Таблетки', nameEn: 'Pills', emoji: '💊' },
        { name: 'Шприц', nameEn: 'Syringe', emoji: '💉' },
        { name: 'Пластырь', nameEn: 'Bandage', emoji: '🩹' },
        { name: 'Термометр', nameEn: 'Thermometer', emoji: '🌡️' },
        { name: 'Крем', nameEn: 'Cream', emoji: '🧴' },
        { name: 'Зубная щетка', nameEn: 'Toothbrush', emoji: '🪥' },
        { name: 'Зубная паста', nameEn: 'Toothpaste', emoji: '🦷' },
        { name: 'Витамины', nameEn: 'Vitamins', emoji: '🧪' },
      ],
    },
  ];

  // Создание категорий и продуктов
  for (const categoryData of categories) {
    const { products, ...categoryInfo } = categoryData;

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

    console.log(`✅ Created category: ${category.emoji} ${category.name} with ${products.length} products`);
  }

  // Подсчет итогов
  const totalCategories = await prisma.category.count();
  const totalProducts = await prisma.product.count();

  console.log('\n🎉 Seed completed successfully!');
  console.log(`📊 Created ${totalCategories} categories`);
  console.log(`📊 Created ${totalProducts} products`);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
