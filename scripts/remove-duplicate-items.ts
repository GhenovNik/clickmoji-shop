import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function removeDuplicateItems() {
  console.log('Checking for duplicate items...');

  // Find all items grouped by listId and productId
  const items = await prisma.item.findMany({
    orderBy: [{ listId: 'asc' }, { productId: 'asc' }, { createdAt: 'asc' }],
  });

  const seen = new Map<string, string>(); // key: listId-productId, value: first item id
  const duplicateIds: string[] = [];

  for (const item of items) {
    const key = `${item.listId}-${item.productId}`;
    if (seen.has(key)) {
      // This is a duplicate
      duplicateIds.push(item.id);
      console.log(
        `Found duplicate: listId=${item.listId}, productId=${item.productId}, itemId=${item.id}`
      );
    } else {
      // First occurrence, keep it
      seen.set(key, item.id);
    }
  }

  if (duplicateIds.length === 0) {
    console.log('No duplicates found!');
    return;
  }

  console.log(`\nFound ${duplicateIds.length} duplicate items. Removing them...`);

  // Delete duplicates
  const result = await prisma.item.deleteMany({
    where: {
      id: {
        in: duplicateIds,
      },
    },
  });

  console.log(`Removed ${result.count} duplicate items.`);
}

removeDuplicateItems()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
