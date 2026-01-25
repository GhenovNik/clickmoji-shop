import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seed...');

  // Проверяем наличие категорий
  const existingCount = await prisma.category.count();

  if (existingCount > 0) {
    console.log(`ℹ️  Database already has ${existingCount} categories.`);
    console.log('💡 Skipping seed to preserve existing data.');
    console.log('   To reset and re-seed, manually delete categories first.');
    return;
  }

  console.log('📦 Creating unique categories and products...');

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
        { name: 'Тыква', nameEn: 'Pumpkin', emoji: '🎃' },
        { name: 'Свекла', nameEn: 'Beetroot', emoji: '🥬' },
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
        { name: 'Авокадо', nameEn: 'Avocado', emoji: '🥑' },
        { name: 'Дыня', nameEn: 'Melon', emoji: '🍈' },
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
        { name: 'Йогурт', nameEn: 'Yogurt', emoji: '🧃' },
        { name: 'Сметана', nameEn: 'Sour Cream', emoji: '🥄' },
        { name: 'Творог', nameEn: 'Cottage Cheese', emoji: '🫕' },
        { name: 'Сливки', nameEn: 'Cream', emoji: '🥛' },
        { name: 'Кефир', nameEn: 'Kefir', emoji: '🥛' },
      ],
    },
    {
      name: 'Хлеб и выпечка',
      nameEn: 'Bread & Bakery',
      emoji: '🍞',
      order: 4,
      products: [
        { name: 'Хлеб белый', nameEn: 'White Bread', emoji: '🍞' },
        { name: 'Хлеб черный', nameEn: 'Rye Bread', emoji: '🍞' },
        { name: 'Багет', nameEn: 'Baguette', emoji: '🥖' },
        { name: 'Бублик', nameEn: 'Bagel', emoji: '🥯' },
        { name: 'Круассан', nameEn: 'Croissant', emoji: '🥐' },
        { name: 'Крендель', nameEn: 'Pretzel', emoji: '🥨' },
        { name: 'Блины', nameEn: 'Pancakes', emoji: '🥞' },
        { name: 'Вафли', nameEn: 'Waffles', emoji: '🧇' },
      ],
    },
    {
      name: 'Сладости',
      nameEn: 'Sweets',
      emoji: '🍬',
      order: 5,
      products: [
        { name: 'Шоколад', nameEn: 'Chocolate', emoji: '🍫' },
        { name: 'Конфеты', nameEn: 'Candy', emoji: '🍬' },
        { name: 'Печенье', nameEn: 'Cookies', emoji: '🍪' },
        { name: 'Кекс', nameEn: 'Cupcake', emoji: '🧁' },
        { name: 'Торт', nameEn: 'Cake', emoji: '🍰' },
        { name: 'Пирожные', nameEn: 'Pastry', emoji: '🧁' },
        { name: 'Мороженое', nameEn: 'Ice Cream', emoji: '🍦' },
        { name: 'Вафли', nameEn: 'Waffles', emoji: '🧇' },
        { name: 'Пудинг', nameEn: 'Pudding', emoji: '🍮' },
        { name: 'Мармелад', nameEn: 'Jelly Candy', emoji: '🍬' },
        { name: 'Зефир', nameEn: 'Marshmallow', emoji: '🍬' },
      ],
    },
    {
      name: 'Мясо и мясные продукты',
      nameEn: 'Meat',
      emoji: '🥩',
      order: 6,
      products: [
        { name: 'Говядина', nameEn: 'Beef', emoji: '🥩' },
        { name: 'Свинина', nameEn: 'Pork', emoji: '🥩' },
        { name: 'Курица', nameEn: 'Chicken', emoji: '🍗' },
        { name: 'Индейка', nameEn: 'Turkey', emoji: '🍗' },
        { name: 'Бекон', nameEn: 'Bacon', emoji: '🥓' },
        { name: 'Сосиски', nameEn: 'Hot Dog', emoji: '🌭' },
        { name: 'Колбаса', nameEn: 'Sausage', emoji: '🌭' },
        { name: 'Фарш', nameEn: 'Minced Meat', emoji: '🥩' },
        { name: 'Мясо на кости', nameEn: 'Meat on Bone', emoji: '🍖' },
      ],
    },
    {
      name: 'Консервы и готовая еда',
      nameEn: 'Canned & Ready Food',
      emoji: '🥫',
      order: 7,
      products: [
        { name: 'Консервы', nameEn: 'Canned Food', emoji: '🥫' },
        { name: 'Пицца', nameEn: 'Pizza', emoji: '🍕' },
        { name: 'Бургер', nameEn: 'Burger', emoji: '🍔' },
        { name: 'Тако', nameEn: 'Taco', emoji: '🌮' },
        { name: 'Буррито', nameEn: 'Burrito', emoji: '🌯' },
        { name: 'Шаурма', nameEn: 'Shawarma', emoji: '🥙' },
        { name: 'Суп', nameEn: 'Soup', emoji: '🍲' },
        { name: 'Салат готовый', nameEn: 'Ready Salad', emoji: '🥗' },
        { name: 'Бенто', nameEn: 'Bento Box', emoji: '🍱' },
        { name: 'Сэндвич', nameEn: 'Sandwich', emoji: '🥪' },
      ],
    },
    {
      name: 'Напитки',
      nameEn: 'Beverages',
      emoji: '🍷',
      order: 8,
      products: [
        { name: 'Вино', nameEn: 'Wine', emoji: '🍷' },
        { name: 'Пиво', nameEn: 'Beer', emoji: '🍺' },
        { name: 'Шампанское', nameEn: 'Champagne', emoji: '🍾' },
        { name: 'Виски', nameEn: 'Whiskey', emoji: '🥃' },
        { name: 'Коктейль', nameEn: 'Cocktail', emoji: '🍸' },
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
      order: 9,
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
      emoji: '🏠',
      order: 10,
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
      order: 11,
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
    {
      name: 'Крупы и макароны',
      nameEn: 'Grains & Pasta',
      emoji: '🌾',
      order: 12,
      products: [
        { name: 'Гречка', nameEn: 'Buckwheat', emoji: '🌾' },
        { name: 'Рис', nameEn: 'Rice', emoji: '🍚' },
        { name: 'Овсянка', nameEn: 'Oatmeal', emoji: '🥣' },
        { name: 'Макароны', nameEn: 'Pasta', emoji: '🍝' },
        { name: 'Спагетти', nameEn: 'Spaghetti', emoji: '🍝' },
        { name: 'Мука', nameEn: 'Flour', emoji: '🌾' },
        { name: 'Перловка', nameEn: 'Pearl Barley', emoji: '🌾' },
        { name: 'Пшено', nameEn: 'Millet', emoji: '🌾' },
        { name: 'Чечевица', nameEn: 'Lentils', emoji: '🍲' },
      ],
    },
    {
      name: 'Орехи и сухофрукты',
      nameEn: 'Nuts & Dried Fruits',
      emoji: '🥜',
      order: 13,
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
      order: 14,
      products: [
        { name: 'Подсолнечное масло', nameEn: 'Sunflower Oil', emoji: '🫗' },
        { name: 'Оливковое масло', nameEn: 'Olive Oil', emoji: '🫒' },
        { name: 'Кетчуп', nameEn: 'Ketchup', emoji: '🍅' },
        { name: 'Майонез', nameEn: 'Mayonnaise', emoji: '🥚' },
        { name: 'Горчица', nameEn: 'Mustard', emoji: '🌭' },
        { name: 'Соевый соус', nameEn: 'Soy Sauce', emoji: '🍶' },
        { name: 'Уксус', nameEn: 'Vinegar', emoji: '🫗' },
        { name: 'Томатная паста', nameEn: 'Tomato Paste', emoji: '🍅' },
        { name: 'Специи', nameEn: 'Spices', emoji: '🧂' },
      ],
    },
    {
      name: 'Замороженные продукты',
      nameEn: 'Frozen',
      emoji: '🧊',
      order: 15,
      products: [
        { name: 'Пельмени', nameEn: 'Dumplings', emoji: '🥟' },
        { name: 'Вареники', nameEn: 'Vareniki', emoji: '🥟' },
        { name: 'Замороженные овощи', nameEn: 'Frozen Vegetables', emoji: '🥦' },
        { name: 'Замороженные ягоды', nameEn: 'Frozen Berries', emoji: '🫐' },
        { name: 'Пицца замороженная', nameEn: 'Frozen Pizza', emoji: '🍕' },
      ],
    },
    {
      name: 'Рыба и морепродукты',
      nameEn: 'Fish & Seafood',
      emoji: '🐟',
      order: 16,
      products: [
        { name: 'Лосось', nameEn: 'Salmon', emoji: '🐟' },
        { name: 'Тунец', nameEn: 'Tuna', emoji: '🐟' },
        { name: 'Сельдь', nameEn: 'Herring', emoji: '🐟' },
        { name: 'Креветки', nameEn: 'Shrimp', emoji: '🍤' },
        { name: 'Кальмар', nameEn: 'Squid', emoji: '🦑' },
        { name: 'Мидии', nameEn: 'Mussels', emoji: '🦪' },
        { name: 'Краб', nameEn: 'Crab', emoji: '🦀' },
        { name: 'Лобстер', nameEn: 'Lobster', emoji: '🦞' },
        { name: 'Икра', nameEn: 'Caviar', emoji: '🥚' },
        { name: 'Осьминог', nameEn: 'Octopus', emoji: '🐙' },
      ],
    },
    {
      name: 'Детское питание',
      nameEn: 'Baby Food',
      emoji: '🍼',
      order: 17,
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
      order: 18,
      products: [
        { name: 'Корм для кошек', nameEn: 'Cat Food', emoji: '🐱' },
        { name: 'Корм для собак', nameEn: 'Dog Food', emoji: '🐶' },
        { name: 'Лакомства для кошек', nameEn: 'Cat Treats', emoji: '🐱' },
        { name: 'Лакомства для собак', nameEn: 'Dog Treats', emoji: '🐶' },
        { name: 'Наполнитель для туалета', nameEn: 'Cat Litter', emoji: '🐾' },
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

    console.log(
      `✅ Created category: ${category.emoji} ${category.name} with ${products.length} products`
    );
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
