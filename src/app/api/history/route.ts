import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { visibleProductsWhere } from '@/lib/product-visibility';

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

type CompleteResult =
  { status: 'not-found' } | { status: 'empty' } | { status: 'completed'; history: unknown };

export async function POST(request: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;
    const userId = session.user.id;

    const body = await request.json();
    const { listId } = body;

    if (!listId) {
      return NextResponse.json({ error: 'List ID is required' }, { status: 400 });
    }

    // Reading the snapshot and removing the items is one transaction under a row lock on the
    // list, and only the items that were read are removed. A second complete of the same list
    // waits for the lock and then finds the list empty; an item added concurrently either is in
    // the snapshot or stays in the list (its insert takes a KEY SHARE lock on the list row for
    // the foreign key, so it waits until this transaction commits).
    const result = await prisma.$transaction(async (tx): Promise<CompleteResult> => {
      const locked = await tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT id, name FROM lists WHERE id = ${listId} AND "userId" = ${userId} FOR UPDATE`;
      const list = locked[0];
      if (!list) return { status: 'not-found' };

      const items = await tx.item.findMany({
        where: { listId: list.id },
        include: {
          product: {
            include: {
              category: true,
            },
          },
          variant: true,
        },
      });

      // Items of another user's private product (legacy rows) are removed with the rest of the
      // list but never copied into the snapshot.
      const visibleProducts =
        items.length > 0
          ? await tx.product.findMany({
              where: {
                id: { in: [...new Set(items.map((item) => item.productId))] },
                ...visibleProductsWhere(userId),
              },
              select: { id: true },
            })
          : [];
      const visibleIds = new Set(visibleProducts.map((product) => product.id));
      const snapshotItems = items.filter((item) => visibleIds.has(item.productId));

      if (snapshotItems.length === 0) return { status: 'empty' };

      const createdHistory = await tx.listHistory.create({
        data: {
          userId,
          listId: list.id,
          listName: list.name,
          completedAt: new Date(),
          items: {
            create: snapshotItems.map((item) => ({
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

      await tx.item.deleteMany({
        where: { listId: list.id, id: { in: items.map((item) => item.id) } },
      });

      return { status: 'completed', history: createdHistory };
    });

    if (result.status === 'not-found') {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    if (result.status === 'empty') {
      return NextResponse.json({ error: 'List is empty' }, { status: 400 });
    }

    return NextResponse.json(result.history);
  } catch (error) {
    console.error('Error completing list:', error);
    return NextResponse.json({ error: 'Failed to complete list' }, { status: 500 });
  }
}
