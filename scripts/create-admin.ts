import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('👤 Creating admin user...\n');

  // Admin credentials
  const email = 'admin@clickmoji.com';
  const password = 'admin123'; // Change this after first login!
  const name = 'Admin';

  // Check if admin already exists
  const existingAdmin = await prisma.user.findUnique({
    where: { email },
  });

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

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Create admin user
  const admin = await prisma.user.create({
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

main()
  .catch((error) => {
    console.error('❌ Error creating admin:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
