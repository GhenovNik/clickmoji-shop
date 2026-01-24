import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Checking database...\n');

  // Проверка пользователей
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  console.log(`👤 Users: ${users.length}`);
  users.forEach((user) => {
    console.log(`  - ${user.name || 'No name'} (${user.email})`);
  });

  // Проверка категорий
  const categories = await prisma.category.findMany({
    select: {
      id: true,
      name: true,
      emoji: true,
    },
    take: 3,
  });

  console.log(`\n📁 Categories: ${await prisma.category.count()}`);
  categories.forEach((cat) => {
    console.log(`  - ${cat.emoji} ${cat.name}`);
  });

  // Проверка кодировки
  const result = await prisma.$queryRaw<{ server_encoding: string; client_encoding: string }[]>`
    SELECT
      current_setting('server_encoding') as server_encoding,
      current_setting('client_encoding') as client_encoding
  `;

  console.log(`\n🔤 Database encoding:`);
  console.log(`  Server: ${result[0].server_encoding}`);
  console.log(`  Client: ${result[0].client_encoding}`);
}

main()
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
