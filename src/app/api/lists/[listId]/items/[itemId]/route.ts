import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';

// PUT /api/lists/[listId]/items/[itemId] - update a list item.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ listId: string; itemId: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { listId, itemId } = await params;

    // Scope the mutation to a list owned by the current user.
    const list = await prisma.list.findUnique({
      where: {
        id: listId,
        userId: session.user.id,
      },
    });

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    const { isPurchased, note } = await request.json();

    const item = await prisma.item.update({
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

    return NextResponse.json(item);
  } catch (error) {
    console.error('Error updating item:', error);
    return NextResponse.json({ error: 'Failed to update item' }, { status: 500 });
  }
}

// DELETE /api/lists/[listId]/items/[itemId] - delete a list item.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ listId: string; itemId: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { listId, itemId } = await params;

    // Scope the mutation to a list owned by the current user.
    const list = await prisma.list.findUnique({
      where: {
        id: listId,
        userId: session.user.id,
      },
    });

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    await prisma.item.deleteMany({
      where: {
        id: itemId,
        listId: listId,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting item:', error);
    return NextResponse.json({ error: 'Failed to delete item' }, { status: 500 });
  }
}
