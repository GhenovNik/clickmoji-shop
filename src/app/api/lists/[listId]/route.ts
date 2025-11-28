import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';

// GET /api/lists/[listId] - получить конкретный список
export async function GET(
  request: Request,
  { params }: { params: { listId: string } }
) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const list = await prisma.list.findUnique({
      where: {
        id: params.listId,
        userId: session.user.id,
      },
      include: {
        items: {
          include: {
            product: {
              include: {
                category: true,
              },
            },
          },
        },
        _count: {
          select: {
            items: true,
          },
        },
      },
    });

    if (!list) {
      return NextResponse.json(
        { error: 'List not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(list);
  } catch (error) {
    console.error('Error fetching list:', error);
    return NextResponse.json(
      { error: 'Failed to fetch list' },
      { status: 500 }
    );
  }
}

// PUT /api/lists/[listId] - обновить список
export async function PUT(
  request: Request,
  { params }: { params: { listId: string } }
) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { name, isActive } = await request.json();

    // Проверяем что список принадлежит пользователю
    const existingList = await prisma.list.findUnique({
      where: {
        id: params.listId,
        userId: session.user.id,
      },
    });

    if (!existingList) {
      return NextResponse.json(
        { error: 'List not found' },
        { status: 404 }
      );
    }

    // Если делаем список активным, деактивируем остальные
    if (isActive && !existingList.isActive) {
      await prisma.list.updateMany({
        where: {
          userId: session.user.id,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });
    }

    const list = await prisma.list.update({
      where: {
        id: params.listId,
      },
      data: {
        ...(name && { name: name.trim() }),
        ...(isActive !== undefined && { isActive }),
      },
      include: {
        _count: {
          select: {
            items: true,
          },
        },
      },
    });

    return NextResponse.json(list);
  } catch (error) {
    console.error('Error updating list:', error);
    return NextResponse.json(
      { error: 'Failed to update list' },
      { status: 500 }
    );
  }
}

// DELETE /api/lists/[listId] - удалить список
export async function DELETE(
  request: Request,
  { params }: { params: { listId: string } }
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

    // Удаляем список (items удалятся автоматически благодаря onDelete: Cascade)
    await prisma.list.delete({
      where: {
        id: params.listId,
      },
    });

    // Если удаляем активный список, активируем первый доступный
    if (list.isActive) {
      const firstList = await prisma.list.findFirst({
        where: {
          userId: session.user.id,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      if (firstList) {
        await prisma.list.update({
          where: {
            id: firstList.id,
          },
          data: {
            isActive: true,
          },
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting list:', error);
    return NextResponse.json(
      { error: 'Failed to delete list' },
      { status: 500 }
    );
  }
}
