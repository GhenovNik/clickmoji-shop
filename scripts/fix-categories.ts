import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Fixing categories - setting isCustom based on imageUrl...\n');

  // Set isCustom=true for categories with imageUrl
  const customResult = await prisma.category.updateMany({
    where: {
      imageUrl: { not: null },
    },
    data: {
      isCustom: true,
    },
  });

  console.log(`✅ Set isCustom=true for ${customResult.count} categories with images`);

  // Set isCustom=false for categories without imageUrl
  const standardResult = await prisma.category.updateMany({
    where: {
      imageUrl: null,
    },
    data: {
      isCustom: false,
    },
  });

  console.log(`✅ Set isCustom=false for ${standardResult.count} standard emoji categories\n`);

  // Show all categories
  const categories = await prisma.category.findMany({
    select: {
      id: true,
      name: true,
      emoji: true,
      isCustom: true,
      imageUrl: true,
    },
    orderBy: { order: 'asc' },
  });

  console.log('📋 Current categories:');
  categories.forEach((cat) => {
    console.log(
      `  ${cat.emoji} ${cat.name} - isCustom: ${cat.isCustom}, imageUrl: ${cat.imageUrl || 'none'}`
    );
  });
}

main()
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
