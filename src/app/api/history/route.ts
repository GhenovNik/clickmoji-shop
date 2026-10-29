import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { visibleItemsWhere, visibleProductsWhere } from '@/lib/product-visibility';

export async function GET() {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const history = await prisma.listHistory.findMany({
      where: { userId: session.user.id },
      include: { items: true },
      orderBy: { completedAt: 'desc' },
      take: 50,
    });

    // Snapshots copy product names but carry no provenance of their own, so a snapshot item is
    // returned only while its product exists and is visible to this user. A deleted or missing
    // product is not permission: a legacy snapshot of another user's private product would
    // otherwise reappear once that product is deleted.
    const snapshotProductIds = [
      ...new Set(
        history.flatMap((entry) =>
          entry.items.map((item) => item.productId).filter((id): id is string => !!id)
        )
      ),
    ];
    const visibleProducts =
      snapshotProductIds.length > 0
        ? await prisma.product.findMany({
            where: {
              id: { in: snapshotProductIds },
              ...visibleProductsWhere(session.user.id),
            },
            select: { id: true },
          })
        : [];
    const visibleIds = new Set(visibleProducts.map((product) => product.id));

    return NextResponse.json(
      history.map((entry) => ({
        ...entry,
        items: entry.items.filter((item) => !!item.productId && visibleIds.has(item.productId)),
      }))
    );
  } catch (error) {
    console.error('Error fetching history:', error);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const body = await request.json();
    const { listId } = body;

    if (!listId) {
      return NextResponse.json({ error: 'List ID is required' }, { status: 400 });
    }

    const list = await prisma.list.findUnique({
      where: { id: listId, userId: session.user.id },
      include: {
        items: {
          where: visibleItemsWhere(session.user.id),
          include: {
            product: {
              include: {
                category: true,
              },
            },
            variant: true,
          },
        },
      },
    });

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    if (list.items.length === 0) {
      return NextResponse.json({ error: 'List is empty' }, { status: 400 });
    }

    const history = await prisma.$transaction(async (tx) => {
      const createdHistory = await tx.listHistory.create({
        data: {
          userId: session.user.id,
          listId: list.id,
          listName: list.name,
          completedAt: new Date(),
          items: {
            create: list.items.map((item) => ({
              productId: item.productId,
              variantId: item.variantId,
              productName: item.product.name,
              productEmoji: item.product.emoji,
              productImageUrl: item.product.imageUrl,
              categoryName: item.product.category.name,
              isCustom: item.product.isCustom,
              variantName: item.variant?.name || null,
              variantEmoji: item.variant?.emoji || null,
              note: item.note || null,
              isPurchased: item.isPurchased,
              addedAt: item.createdAt,
            })),
          },
        },
        include: { items: true },
      });

      await tx.item.deleteMany({ where: { listId: list.id } });

      return createdHistory;
    });

    return NextResponse.json(history);
  } catch (error) {
    console.error('Error completing list:', error);
    return NextResponse.json({ error: 'Failed to complete list' }, { status: 500 });
  }
}
