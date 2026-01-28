import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ historyId: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { historyId } = await params;
    const body = await request.json().catch(() => ({}));
    const { name } = body as { name?: string };

    const history = await prisma.listHistory.findUnique({
      where: { id: historyId, userId: session.user.id },
      include: { items: true },
    });

    if (!history) {
      return NextResponse.json({ error: 'History not found' }, { status: 404 });
    }

    const productIds = history.items
      .map((item) => item.productId)
      .filter((id): id is string => !!id);
    const variantIds = history.items
      .map((item) => item.variantId)
      .filter((id): id is string => !!id);

    const [products, variants] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true },
      }),
      prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: { id: true, productId: true },
      }),
    ]);

    const productSet = new Set(products.map((product) => product.id));
    const variantMap = new Map(variants.map((variant) => [variant.id, variant.productId]));

    const itemsToCreate = history.items
      .filter((item) => item.productId && productSet.has(item.productId))
      .map((item) => ({
        productId: item.productId as string,
        variantId:
          item.variantId && variantMap.get(item.variantId) === item.productId
            ? item.variantId
            : null,
        note: item.note || null,
        isPurchased: false,
      }));

    const list = await prisma.list.create({
      data: {
        userId: session.user.id,
        name: name || history.listName,
        isActive: false,
      },
    });

    if (itemsToCreate.length > 0) {
      await prisma.item.createMany({
        data: itemsToCreate.map((item) => ({
          ...item,
          listId: list.id,
        })),
      });
    }

    return NextResponse.json({
      listId: list.id,
      createdCount: itemsToCreate.length,
      skippedCount: history.items.length - itemsToCreate.length,
    });
  } catch (error) {
    console.error('Error restoring history:', error);
    return NextResponse.json({ error: 'Failed to restore history' }, { status: 500 });
  }
}
