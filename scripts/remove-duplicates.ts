/**
 * Remove Duplicate Products Script
 *
 * This script finds and removes duplicate products from the database.
 * Duplicates are identified by having the same name (Russian) or nameEn (English).
 *
 * For each set of duplicates, the oldest product (by createdAt) is kept,
 * and all newer duplicates are deleted.
 *
 * Usage:
 *   tsx scripts/remove-duplicates.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Searching for duplicate products...\n');

  // Find all products
  const allProducts = await prisma.product.findMany({
    orderBy: {
      createdAt: 'asc', // Oldest first
    },
  });

  console.log(`📊 Total products in database: ${allProducts.length}\n`);

  // Track seen names and products to delete
  const seenByNameRu = new Map<string, string>(); // name -> id
  const seenByNameEn = new Map<string, string>(); // nameEn -> id
  const toDelete: string[] = [];

  for (const product of allProducts) {
    let isDuplicate = false;

    // Check for duplicate by Russian name
    if (seenByNameRu.has(product.name)) {
      const originalId = seenByNameRu.get(product.name)!;
      console.log(`❌ Duplicate found (by Russian name):`);
      console.log(`   Original: ${product.name} (ID: ${originalId})`);
      console.log(`   Duplicate: ${product.name} (ID: ${product.id})`);
      toDelete.push(product.id);
      isDuplicate = true;
    }

    // Check for duplicate by English name
    if (seenByNameEn.has(product.nameEn)) {
      const originalId = seenByNameEn.get(product.nameEn)!;
      if (!isDuplicate) {
        console.log(`❌ Duplicate found (by English name):`);
        console.log(`   Original: ${product.nameEn} (ID: ${originalId})`);
        console.log(`   Duplicate: ${product.nameEn} (ID: ${product.id})`);
        toDelete.push(product.id);
        isDuplicate = true;
      }
    }

    // Register this product if not a duplicate
    if (!isDuplicate) {
      seenByNameRu.set(product.name, product.id);
      seenByNameEn.set(product.nameEn, product.id);
    }
  }

  console.log(`\n📊 Found ${toDelete.length} duplicate products\n`);

  if (toDelete.length === 0) {
    console.log('✅ No duplicates found. Database is clean!');
    return;
  }

  console.log('🗑️  Deleting duplicates...\n');

  // Delete duplicates
  const deleteResult = await prisma.product.deleteMany({
    where: {
      id: {
        in: toDelete,
      },
    },
  });

  console.log(`✅ Deleted ${deleteResult.count} duplicate products\n`);

  const remainingProducts = await prisma.product.count();
  console.log(`📊 Remaining products: ${remainingProducts}`);
  console.log('🎉 Done!');
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
