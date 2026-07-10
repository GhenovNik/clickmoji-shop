import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';

// POST /api/lists/[listId]/items - add products to a shopping list.
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

    // Duplicate products are allowed when users need separate notes.
    const createdItems = [];

    for (const item of items) {
      // Reject references to products that no longer exist.
      const productExists = await prisma.product.findUnique({
        where: { id: item.productId },
      });

      if (!productExists) {
        console.error('❌ Product not found:', item.productId);
        return NextResponse.json(
          { error: `Product with ID ${item.productId} not found` },
          { status: 404 }
        );
      }

      if (item.variantId) {
        const variant = await prisma.productVariant.findUnique({
          where: { id: item.variantId },
          select: { productId: true },
        });

        if (!variant || variant.productId !== item.productId) {
          return NextResponse.json(
            { error: 'Variant does not belong to product' },
            { status: 400 }
          );
        }
      }

      const createdItem = await prisma.item.create({
        data: {
          listId: listId,
          productId: item.productId,
          variantId: item.variantId || null,
          note: item.note || null,
        },
        include: {
          product: {
            include: {
              category: true,
            },
          },
        },
      });
      createdItems.push(createdItem);
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
