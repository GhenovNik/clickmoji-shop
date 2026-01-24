import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('👤 Creating test user...\n');

  const email = 'test@example.com';
  const password = 'test123';
  const name = 'Test User';

  // Проверяем, не существует ли уже
  const existing = await prisma.user.findUnique({
    where: { email },
  });

  if (existing) {
    console.log('✅ User already exists:');
    console.log(`   Email: ${email}`);
    console.log(`   Password: test123`);
    console.log('\n💡 You can login with these credentials');
    return;
  }

  // Создаем пользователя
  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      name,
      emailVerified: new Date(),
    },
  });

  console.log('✅ Test user created successfully!\n');
  console.log('📋 Login credentials:');
  console.log(`   Email: ${email}`);
  console.log(`   Password: ${password}`);
  console.log('\n💡 Use these to login at http://localhost:3000/login');
}

main()
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
