import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { HISTORY_ITEM_OMIT, PRODUCT_OMIT, VARIANT_OMIT } from '@/lib/catalog-omit';
import { requireUser } from '@/lib/auth-guards';
import {
  keepSnapshotVariant,
  variantOfItemProduct,
  visibleProductsWhere,
  visibleVariantProductIds,
} from '@/lib/product-visibility';
import { lockOwnedList } from '@/lib/list-lock';
import { historyPictureFields } from '@/lib/picture-storage';
import {
  readVisibleSnapshotPictures,
  type SnapshotPictures,
} from '../../../../scripts/lib/legacy-picture-transition';

export async function GET(request?: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const history = await prisma.listHistory.findMany({
      where: { userId: session.user.id },
      include: { items: { omit: HISTORY_ITEM_OMIT } },
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

    // A snapshot's variant fields are returned only while the variant is visible through its own
    // product and agrees with the snapshot product (the same check the account export applies).
    const snapshotVariantIds = [
      ...new Set(
        history.flatMap((entry) =>
          entry.items.map((item) => item.variantId).filter((id): id is string => !!id)
        )
      ),
    ];
    const visibleVariantIds = await visibleVariantProductIds(
      prisma,
      session.user.id,
      snapshotVariantIds
    );

    return NextResponse.json(
      history.map((entry) => ({
        ...entry,
        items: entry.items
          .filter((item) => !!item.productId && visibleIds.has(item.productId))
          .map((item) => keepSnapshotVariant(item, visibleVariantIds)),
      }))
    );
  } catch (error) {
    console.error('Error fetching history:', error);
    return NextResponse.json(
      { error: await apiText(request, 'fetchHistoryFailed') },
      { status: 500 }
    );
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
      return NextResponse.json(
        { error: await apiText(request, 'listIdRequired') },
        { status: 400 }
      );
    }

    // Reading the snapshot and removing the items is one transaction that holds the list lock
    // (see lockOwnedList) and then the item rows, and only the items that were read are removed.
    // Every add, update and delete of an item takes the same list lock first, so it either commits
    // before the snapshot is read (and is in it) or waits and then finds the item gone; a second
    // complete waits and then finds the list empty. Lock order is always list, then items.
    const result = await prisma.$transaction(async (tx): Promise<CompleteResult> => {
      const list = await lockOwnedList(tx, listId, userId);
      if (!list) return { status: 'not-found' };

      await tx.$queryRaw`SELECT id FROM items WHERE "listId" = ${list.id} FOR UPDATE`;

      const items = await tx.item.findMany({
        where: { listId: list.id },
        include: {
          product: {
            omit: PRODUCT_OMIT,
            include: {
              category: true,
            },
          },
          variant: { omit: VARIANT_OMIT },
        },
      });

      // Items of another user's private product (legacy rows) are removed with the rest of the
      // list but never copied into the snapshot. The same statement reads the pictures of the
      // visible products: the snapshot is never refilled later, so a product whose English
      // address is still only in the legacy column (the previous release writes it alone) gets it
      // folded into the dictionary here. The legacy column of the same read wins, an explicit null
      // included, as in the backfill (see legacy-picture-transition.ts).
      // A product that is not visible is not read, so it has no fallback either.
      const pictures =
        items.length > 0
          ? await readVisibleSnapshotPictures(tx, {
              id: { in: [...new Set(items.map((item) => item.productId))] },
              ...visibleProductsWhere(userId),
            })
          : new Map<string, SnapshotPictures>();
      const snapshotItems = items.flatMap((item) => {
        const productPictures = pictures.get(item.productId);
        return productPictures ? [{ item, pictures: productPictures }] : [];
      });

      if (snapshotItems.length === 0) return { status: 'empty' };

      const createdHistory = await tx.listHistory.create({
        data: {
          userId,
          listId: list.id,
          listName: list.name,
          completedAt: new Date(),
          items: {
            create: snapshotItems.map(({ item, pictures: productPictures }) => {
              // Only a variant of the item's own (visible) product is copied; a legacy foreign
              // variant is neither identified nor copied into the snapshot.
              const variant = variantOfItemProduct(item.variant, item.productId);
              return {
                productId: item.productId,
                variantId: variant?.id ?? null,
                productName: item.product.name,
                productNameEn: item.product.nameEn || null,
                productEmoji: item.product.emoji,
                ...historyPictureFields(productPictures),
                categoryName: item.product.category.name,
                categoryNameEn: item.product.category.nameEn || null,
                isCustom: item.product.isCustom,
                variantName: variant?.name || null,
                variantNameEn: variant?.nameEn || null,
                variantEmoji: variant?.emoji || null,
                note: item.note || null,
                isPurchased: item.isPurchased,
                addedAt: item.createdAt,
              };
            }),
          },
        },
        include: { items: { omit: HISTORY_ITEM_OMIT } },
      });

      await tx.item.deleteMany({
        where: { listId: list.id, id: { in: items.map((item) => item.id) } },
      });

      return { status: 'completed', history: createdHistory };
    });

    if (result.status === 'not-found') {
      return NextResponse.json({ error: await apiText(request, 'listNotFound') }, { status: 404 });
    }

    if (result.status === 'empty') {
      return NextResponse.json({ error: await apiText(request, 'listEmpty') }, { status: 400 });
    }

    return NextResponse.json(result.history);
  } catch (error) {
    console.error('Error completing list:', error);
    return NextResponse.json(
      { error: await apiText(request, 'completeListFailed') },
      { status: 500 }
    );
  }
}
