import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { visibleProductsWhere } from '@/lib/product-visibility';
import { lockOwnedList } from '@/lib/list-lock';

// Upper bound for one request; the largest category has far fewer products than this.
const MAX_ITEMS_PER_BATCH = 100;

type NewItem = { productId: string; variantId: string | null; note: string | null };

function parseItem(raw: unknown): NewItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const { productId, variantId, note } = raw as Record<string, unknown>;
  if (typeof productId !== 'string' || productId.length === 0) return null;
  if (variantId != null && typeof variantId !== 'string') return null;
  if (note != null && typeof note !== 'string') return null;
  return { productId, variantId: variantId || null, note: note || null };
}

// POST /api/lists/[listId]/items - add products to a shopping list.
// The whole batch is validated before the first write and written in one transaction, so a
// request either adds every item or none of them.
export async function POST(request: Request, { params }: { params: Promise<{ listId: string }> }) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { listId } = await params;

    // Scope every mutation to a list owned by the current user.
    const list = await prisma.list.findUnique({
      where: {
        id: listId,
        userId: session.user.id,
      },
    });

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    const { items } = await request.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Items array is required' }, { status: 400 });
    }

    if (items.length > MAX_ITEMS_PER_BATCH) {
      return NextResponse.json(
        { error: `Too many items (maximum ${MAX_ITEMS_PER_BATCH} per request)` },
        { status: 400 }
      );
    }

    const newItems = items.map(parseItem);
    if (newItems.some((item) => item === null)) {
      return NextResponse.json({ error: 'Each item needs a productId string' }, { status: 400 });
    }
    const batch = newItems as NewItem[];

    // One lookup for all products and one for all variants, whatever the batch size.
    const productIds = [...new Set(batch.map((item) => item.productId))];
    const variantIds = [
      ...new Set(batch.map((item) => item.variantId).filter((id): id is string => !!id)),
    ];
    const [visibleProducts, variants] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: productIds }, ...visibleProductsWhere(session.user.id) },
        select: { id: true },
      }),
      variantIds.length > 0
        ? prisma.productVariant.findMany({
            where: { id: { in: variantIds } },
            select: { id: true, productId: true },
          })
        : Promise.resolve([]),
    ]);
    const visibleIds = new Set(visibleProducts.map((product) => product.id));
    const variantProduct = new Map(variants.map((variant) => [variant.id, variant.productId]));

    for (const item of batch) {
      // Reject products that no longer exist or are another user's private product.
      if (!visibleIds.has(item.productId)) {
        console.error('❌ Product not found:', item.productId);
        return NextResponse.json(
          { error: `Product with ID ${item.productId} not found` },
          { status: 404 }
        );
      }

      if (item.variantId && variantProduct.get(item.variantId) !== item.productId) {
        return NextResponse.json({ error: 'Variant does not belong to product' }, { status: 400 });
      }
    }

    // Duplicate products are allowed when users need separate notes. The insert runs under the
    // list lock shared by every change to the list's items (see lockOwnedList).
    const createdItems = await prisma.$transaction(async (tx) => {
      if (!(await lockOwnedList(tx, listId, session.user.id))) return null;
      return tx.item.createManyAndReturn({
        data: batch.map((item) => ({
          listId,
          productId: item.productId,
          variantId: item.variantId,
          note: item.note,
        })),
        include: {
          product: {
            include: {
              category: true,
            },
          },
        },
      });
    });

    if (!createdItems) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    return NextResponse.json({
      createdItems,
      message: `Добавлено ${createdItems.length} товаров.`,
    });
  } catch (error) {
    console.error('Error adding items to list:', error);
    return NextResponse.json({ error: 'Failed to add items' }, { status: 500 });
  }
}
