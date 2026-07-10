import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';

// GET /api/lists - list the current user's shopping lists.
export async function GET() {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const lists = await prisma.list.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        _count: {
          select: {
            items: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return NextResponse.json(lists);
  } catch (error) {
    console.error('Error fetching lists:', error);
    return NextResponse.json({ error: 'Failed to fetch lists' }, { status: 500 });
  }
}

// POST /api/lists - create a shopping list.
export async function POST(request: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { name, isActive } = await request.json();

    if (!name || name.trim() === '') {
      return NextResponse.json({ error: 'List name is required' }, { status: 400 });
    }

    const list = await prisma.$transaction(async (tx) => {
      if (isActive) {
        await tx.list.updateMany({
          where: {
            userId: session.user.id,
            isActive: true,
          },
          data: {
            isActive: false,
          },
        });
      }

      return tx.list.create({
        data: {
          name: name.trim(),
          isActive: Boolean(isActive),
          userId: session.user.id,
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

    return NextResponse.json(list);
  } catch (error) {
    console.error('Error creating list:', error);
    return NextResponse.json({ error: 'Failed to create list' }, { status: 500 });
  }
}
