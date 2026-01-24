import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Adding note column to items table...');

  try {
    // Пытаемся добавить колонку note, если её нет
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "items"
      ADD COLUMN IF NOT EXISTS "note" TEXT;
    `);

    console.log('✅ Column "note" added successfully (or already exists)');

    // Проверяем результат
    const result = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'items'
      ORDER BY ordinal_position;
    `;

    console.log('\n📋 Current columns in "items" table:');
    result.forEach((col) => console.log(`  - ${col.column_name}`));
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

main()
  .then(() => {
    console.log('\n🎉 Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
