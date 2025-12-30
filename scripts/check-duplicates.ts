import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkDuplicates() {
  console.log('Checking for duplicate items in all lists...\n');

  // Get all lists
  const lists = await prisma.list.findMany({
    include: {
      items: {
        include: {
          product: {
            select: {
              name: true,
              emoji: true,
            },
          },
        },
      },
    },
  });

  let totalDuplicates = 0;

  for (const list of lists) {
    console.log(`\nList: ${list.name} (ID: ${list.id})`);
    console.log(`Total items: ${list.items.length}`);

    // Group items by productId
    const productCounts = new Map<string, typeof list.items>();

    for (const item of list.items) {
      if (!productCounts.has(item.productId)) {
        productCounts.set(item.productId, []);
      }
      productCounts.get(item.productId)!.push(item);
    }

    // Find duplicates
    const duplicates = Array.from(productCounts.entries()).filter(([_, items]) => items.length > 1);

    if (duplicates.length > 0) {
      console.log(`\n⚠️  Found ${duplicates.length} products with duplicates:`);

      for (const [productId, items] of duplicates) {
        const product = items[0].product;
        console.log(`  ${product.emoji} ${product.name}: ${items.length} copies`);
        console.log(`    Item IDs: ${items.map(i => i.id).join(', ')}`);
        totalDuplicates += items.length - 1; // Count extra copies
      }
    } else {
      console.log('  ✓ No duplicates in this list');
    }
  }

  console.log(`\n\nTotal duplicate items found: ${totalDuplicates}`);

  if (totalDuplicates > 0) {
    console.log('\nTo remove duplicates, run: npm run remove-duplicates');
  }
}

checkDuplicates()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
