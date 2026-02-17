import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(),
});

type Command = 'check-lists' | 'check-duplicates' | 'remove-duplicate-items' | 'check-constraint';

const commands: Command[] = [
  'check-lists',
  'check-duplicates',
  'remove-duplicate-items',
  'check-constraint',
];

type PrismaErrorLike = {
  code?: string;
  message?: string;
};

const isPrismaError = (value: unknown): value is PrismaErrorLike =>
  typeof value === 'object' && value !== null;

const usage = () => {
  console.log('Usage:');
  console.log('  npx tsx scripts/db-lists.ts <command>');
  console.log('');
  console.log('Available commands:');
  commands.forEach((command) => console.log(`  - ${command}`));
};

async function checkLists() {
  const lists = await prisma.list.findMany({
    include: {
      _count: { select: { items: true } },
      user: { select: { email: true } },
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

async function checkDuplicates() {
  console.log('Checking for duplicate items in all lists...\n');

  const lists = await prisma.list.findMany({
    include: {
      items: {
        include: {
          product: { select: { name: true, emoji: true } },
        },
      },
    },
  });

  let totalDuplicates = 0;

  for (const list of lists) {
    console.log(`\nList: ${list.name} (ID: ${list.id})`);
    console.log(`Total items: ${list.items.length}`);

    const productCounts = new Map<string, typeof list.items>();

    for (const item of list.items) {
      if (!productCounts.has(item.productId)) {
        productCounts.set(item.productId, []);
      }
      productCounts.get(item.productId)!.push(item);
    }

    const duplicates = Array.from(productCounts.entries()).filter(([_, items]) => items.length > 1);

    if (duplicates.length > 0) {
      console.log(`\n⚠️  Found ${duplicates.length} products with duplicates:`);

      for (const [productId, items] of duplicates) {
        const product = items[0].product;
        console.log(`  ${product.emoji} ${product.name}: ${items.length} copies`);
        console.log(`    Item IDs: ${items.map((i) => i.id).join(', ')}`);
        totalDuplicates += items.length - 1;
      }
    } else {
      console.log('  ✓ No duplicates in this list');
    }
  }

  console.log(`\n\nTotal duplicate items found: ${totalDuplicates}`);

  if (totalDuplicates > 0) {
    console.log('\nTo remove duplicates, run: npx tsx scripts/db-lists.ts remove-duplicate-items');
  }
}

async function removeDuplicateItems() {
  console.log('Checking for duplicate items...');

  const items = await prisma.item.findMany({
    orderBy: [{ listId: 'asc' }, { productId: 'asc' }, { createdAt: 'asc' }],
  });

  const seen = new Map<string, string>();
  const duplicateIds: string[] = [];

  for (const item of items) {
    const key = `${item.listId}-${item.productId}`;
    if (seen.has(key)) {
      duplicateIds.push(item.id);
      console.log(
        `Found duplicate: listId=${item.listId}, productId=${item.productId}, itemId=${item.id}`
      );
    } else {
      seen.set(key, item.id);
    }
  }

  if (duplicateIds.length === 0) {
    console.log('No duplicates found!');
    return;
  }

  console.log(`\nFound ${duplicateIds.length} duplicate items. Removing them...`);

  const result = await prisma.item.deleteMany({
    where: { id: { in: duplicateIds } },
  });

  console.log(`Removed ${result.count} duplicate items.`);
}

async function checkConstraint() {
  console.log('Checking unique constraint on items table...\n');

  try {
    const lists = await prisma.list.findMany();
    const products = await prisma.product.findMany({ take: 1 });

    if (lists.length === 0 || products.length === 0) {
      console.log('No lists or products found to test with');
      return;
    }

    const testList = lists[0];
    const testProduct = products[0];

    console.log(`Testing with list "${testList.name}" and product "${testProduct.name}"`);

    const item1 = await prisma.item.create({
      data: {
        listId: testList.id,
        productId: testProduct.id,
      },
    });
    console.log('✓ First item created:', item1.id);

    try {
      const item2 = await prisma.item.create({
        data: {
          listId: testList.id,
          productId: testProduct.id,
        },
      });
      console.log('✗ ERROR: Second item was created! Unique constraint is NOT working!', item2.id);
    } catch (error: unknown) {
      if (isPrismaError(error) && error.code === 'P2002') {
        console.log('✓ Unique constraint is working! Duplicate was rejected.');
      } else {
        const message = isPrismaError(error) ? error.message : 'Unknown error';
        console.log('✗ Unexpected error:', message);
      }
    }

    await prisma.item.delete({ where: { id: item1.id } });
    console.log('✓ Test item cleaned up');
  } catch (error: unknown) {
    const message = isPrismaError(error) ? error.message : 'Unknown error';
    console.error('Error during test:', message);
  }
}

async function main() {
  const command = process.argv[2] as Command | undefined;

  if (!command || !commands.includes(command)) {
    usage();
    process.exit(command ? 1 : 0);
  }

  if (command === 'check-lists') {
    await checkLists();
  } else if (command === 'check-duplicates') {
    await checkDuplicates();
  } else if (command === 'remove-duplicate-items') {
    await removeDuplicateItems();
  } else if (command === 'check-constraint') {
    await checkConstraint();
  }
}

main()
  .catch((error) => {
    console.error('DB lists error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
