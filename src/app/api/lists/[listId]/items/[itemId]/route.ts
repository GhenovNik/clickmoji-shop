import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';

// PUT /api/lists/[listId]/items/[itemId] - обновить товар
export async function PUT(
  request: Request,
  { params }: { params: { listId: string; itemId: string } }
) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Проверяем что список принадлежит пользователю
    const list = await prisma.list.findUnique({
      where: {
        id: params.listId,
        userId: session.user.id,
      },
    });

    if (!list) {
      return NextResponse.json(
        { error: 'List not found' },
        { status: 404 }
      );
    }

    const { isPurchased } = await request.json();

    const item = await prisma.item.update({
      where: {
        id: params.itemId,
        listId: params.listId,
      },
      data: {
        isPurchased,
        ...(isPurchased && { purchasedAt: new Date() }),
        ...(!isPurchased && { purchasedAt: null }),
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
    return NextResponse.json(
      { error: 'Failed to update item' },
      { status: 500 }
    );
  }
}

// DELETE /api/lists/[listId]/items/[itemId] - удалить товар
export async function DELETE(
  request: Request,
  { params }: { params: { listId: string; itemId: string } }
) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Проверяем что список принадлежит пользователю
    const list = await prisma.list.findUnique({
      where: {
        id: params.listId,
        userId: session.user.id,
      },
    });

    if (!list) {
      return NextResponse.json(
        { error: 'List not found' },
        { status: 404 }
      );
    }

    await prisma.item.delete({
      where: {
        id: params.itemId,
        listId: params.listId,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting item:', error);
    return NextResponse.json(
      { error: 'Failed to delete item' },
      { status: 500 }
    );
  }
}
