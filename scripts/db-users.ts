import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

type Command = 'verify-users' | 'create-admin' | 'create-test-user' | 'check-db';

const commands: Command[] = ['verify-users', 'create-admin', 'create-test-user', 'check-db'];

const usage = () => {
  console.log('Usage:');
  console.log('  npx tsx scripts/db-users.ts <command>');
  console.log('');
  console.log('Available commands:');
  commands.forEach((command) => console.log(`  - ${command}`));
};

async function verifyUsers() {
  const result = await prisma.user.updateMany({
    where: {
      emailVerified: null,
      NOT: { password: null },
    },
    data: {
      emailVerified: new Date(),
    },
  });

  console.log(`✅ Verified ${result.count} local users`);
}

async function createAdmin() {
  console.log('👤 Creating admin user...\n');

  const email = 'admin@clickmoji.com';
  const password = 'admin123';
  const name = 'Admin';

  const existingAdmin = await prisma.user.findUnique({ where: { email } });

  if (existingAdmin) {
    console.log('⚠️  Admin user already exists:', email);
    console.log('Updating role to ADMIN...\n');

    await prisma.user.update({
      where: { email },
      data: { role: 'ADMIN', emailVerified: new Date() },
    });

    console.log('✅ User role updated to ADMIN');
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.create({
    data: {
      email,
      name,
      password: hashedPassword,
      role: 'ADMIN',
      emailVerified: new Date(),
    },
  });

  console.log('✅ Admin user created successfully!\n');
  console.log('📧 Email:', email);
  console.log('🔑 Password:', password);
  console.log('\n⚠️  IMPORTANT: Change this password after first login!\n');
}

async function createTestUser() {
  console.log('👤 Creating test user...\n');

  const email = 'test@example.com';
  const password = 'test123';
  const name = 'Test User';

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log('✅ User already exists:');
    console.log(`   Email: ${email}`);
    console.log(`   Password: test123`);
    console.log('\n💡 You can login with these credentials');
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.create({
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

async function checkDatabase() {
  console.log('🔍 Checking database...\n');

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true },
  });

  console.log(`👤 Users: ${users.length}`);
  users.forEach((user) => {
    console.log(`  - ${user.name || 'No name'} (${user.email})`);
  });

  const categories = await prisma.category.findMany({
    select: { id: true, name: true, emoji: true },
    take: 3,
  });

  console.log(`\n📁 Categories: ${await prisma.category.count()}`);
  categories.forEach((cat) => {
    console.log(`  - ${cat.emoji} ${cat.name}`);
  });

  const result = await prisma.$queryRaw<{ server_encoding: string; client_encoding: string }[]>`
    SELECT
      current_setting('server_encoding') as server_encoding,
      current_setting('client_encoding') as client_encoding
  `;

  console.log(`\n🔤 Database encoding:`);
  console.log(`  Server: ${result[0].server_encoding}`);
  console.log(`  Client: ${result[0].client_encoding}`);
}

async function main() {
  const command = process.argv[2] as Command | undefined;

  if (!command || !commands.includes(command)) {
    usage();
    process.exit(command ? 1 : 0);
  }

  if (command === 'verify-users') {
    await verifyUsers();
  } else if (command === 'create-admin') {
    await createAdmin();
  } else if (command === 'create-test-user') {
    await createTestUser();
  } else if (command === 'check-db') {
    await checkDatabase();
  }
}

main()
  .catch((error) => {
    console.error('DB users error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
