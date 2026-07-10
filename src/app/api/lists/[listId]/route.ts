import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';

// GET /api/lists/[listId] - fetch a shopping list.
export async function GET(request: Request, { params }: { params: Promise<{ listId: string }> }) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { listId } = await params;

    const list = await prisma.list.findFirst({
      where: {
        id: listId,
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
            variant: true,
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
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    return NextResponse.json(list);
  } catch (error) {
    console.error('Error fetching list:', error);
    return NextResponse.json({ error: 'Failed to fetch list' }, { status: 500 });
  }
}

// PUT /api/lists/[listId] - update a shopping list.
export async function PUT(request: Request, { params }: { params: Promise<{ listId: string }> }) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { listId } = await params;
    const { name, isActive } = await request.json();

    const list = await prisma.$transaction(async (tx) => {
      const existingList = await tx.list.findFirst({
        where: {
          id: listId,
          userId: session.user.id,
        },
      });

      if (!existingList) {
        return null;
      }

      if (isActive && !existingList.isActive) {
        await tx.list.updateMany({
          where: {
            userId: session.user.id,
            isActive: true,
            id: {
              not: listId,
            },
          },
          data: {
            isActive: false,
          },
        });
      }

      return tx.list.update({
        where: {
          id: listId,
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
    });

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    return NextResponse.json(list);
  } catch (error) {
    console.error('Error updating list:', error);
    return NextResponse.json({ error: 'Failed to update list' }, { status: 500 });
  }
}

// DELETE /api/lists/[listId] - delete a shopping list.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ listId: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { listId } = await params;

    const deletedList = await prisma.$transaction(async (tx) => {
      const list = await tx.list.findFirst({
        where: {
          id: listId,
          userId: session.user.id,
        },
      });

      if (!list) {
        return null;
      }

      await tx.list.delete({
        where: {
          id: listId,
        },
      });

      if (list.isActive) {
        const firstList = await tx.list.findFirst({
          where: {
            userId: session.user.id,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });

        if (firstList) {
          await tx.list.update({
            where: {
              id: firstList.id,
            },
            data: {
              isActive: true,
            },
          });
        }
      }

      return list;
    });

    if (!deletedList) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting list:', error);
    return NextResponse.json({ error: 'Failed to delete list' }, { status: 500 });
  }
}
