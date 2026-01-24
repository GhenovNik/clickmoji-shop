import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkLists() {
  const lists = await prisma.list.findMany({
    include: {
      _count: {
        select: { items: true },
      },
      user: {
        select: { email: true },
      },
    },
  });

  console.log(`\nВсего списков в базе: ${lists.length}\n`);

  if (lists.length === 0) {
    console.log('❌ Списки не найдены!');
  } else {
    lists.forEach((list) => {
      console.log(`📋 ${list.name}`);
      console.log(`   ID: ${list.id}`);
      console.log(`   User: ${list.user.email}`);
      console.log(`   Items: ${list._count.items}`);
      console.log(`   Active: ${list.isActive}`);
      console.log('');
    });
  }
}

checkLists()
  .catch((error) => {
    console.error('Error:', error);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
