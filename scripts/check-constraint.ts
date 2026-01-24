import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PrismaErrorLike = {
  code?: string;
  message?: string;
};

const isPrismaError = (value: unknown): value is PrismaErrorLike =>
  typeof value === 'object' && value !== null;

async function checkConstraint() {
  console.log('Checking unique constraint on items table...\n');

  // Try to add the same product twice to see if constraint works
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

    // Try to add the product
    const item1 = await prisma.item.create({
      data: {
        listId: testList.id,
        productId: testProduct.id,
      },
    });
    console.log('✓ First item created:', item1.id);

    // Try to add the same product again - this should fail
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

    // Clean up
    await prisma.item.delete({ where: { id: item1.id } });
    console.log('✓ Test item cleaned up');
  } catch (error: unknown) {
    const message = isPrismaError(error) ? error.message : 'Unknown error';
    console.error('Error during test:', message);
  }
}

checkConstraint()
  .then(() => {
    console.log('\nTest completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
