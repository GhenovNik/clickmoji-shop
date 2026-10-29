import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { visibleItemsWhere } from '@/lib/product-visibility';
import { lockOwnedList } from '@/lib/list-lock';

// PUT /api/lists/[listId]/items/[itemId] - update a list item.
// Runs under the list lock shared by every change to the list's items (see lockOwnedList), so an
// update cannot slip between the snapshot read and the delete of a concurrent list completion.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ listId: string; itemId: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { listId, itemId } = await params;
    const { isPurchased, note } = await request.json();

    const result = await prisma.$transaction(async (tx) => {
      // Scope the mutation to a list owned by the current user.
      if (!(await lockOwnedList(tx, listId, session.user.id))) return 'list-not-found' as const;

      // A legacy item of another user's private product is neither updated nor returned.
      const existingItem = await tx.item.findFirst({
        where: { id: itemId, listId, ...visibleItemsWhere(session.user.id) },
        select: { id: true },
      });

      if (!existingItem) return 'item-not-found' as const;

      return tx.item.update({
        where: {
          id: itemId,
          listId: listId,
        },
        data: {
          ...(isPurchased !== undefined && {
            isPurchased,
            ...(isPurchased && { purchasedAt: new Date() }),
            ...(!isPurchased && { purchasedAt: null }),
          }),
          ...(note !== undefined && { note }),
        },
        include: {
          product: {
            include: {
              category: true,
            },
          },
        },
      });
    });

    if (result === 'list-not-found') {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    if (result === 'item-not-found') {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error updating item:', error);
    return NextResponse.json({ error: 'Failed to update item' }, { status: 500 });
  }
}

// DELETE /api/lists/[listId]/items/[itemId] - delete a list item, under the same list lock.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ listId: string; itemId: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { listId, itemId } = await params;

    const found = await prisma.$transaction(async (tx) => {
      // Scope the mutation to a list owned by the current user.
      if (!(await lockOwnedList(tx, listId, session.user.id))) return false;

      await tx.item.deleteMany({
        where: {
          id: itemId,
          listId: listId,
        },
      });
      return true;
    });

    if (!found) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting item:', error);
    return NextResponse.json({ error: 'Failed to delete item' }, { status: 500 });
  }
}
