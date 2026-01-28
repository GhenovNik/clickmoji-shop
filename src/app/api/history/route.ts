import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';

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

    return NextResponse.json(history);
  } catch (error) {
    console.error('Error fetching history:', error);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const body = await request.json();
    const { listId } = body;

    if (!listId) {
      return NextResponse.json({ error: 'List ID is required' }, { status: 400 });
    }

    const list = await prisma.list.findUnique({
      where: { id: listId, userId: session.user.id },
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
      },
    });

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    if (list.items.length === 0) {
      return NextResponse.json({ error: 'List is empty' }, { status: 400 });
    }

    const history = await prisma.$transaction(async (tx) => {
      const createdHistory = await tx.listHistory.create({
        data: {
          userId: session.user.id,
          listId: list.id,
          listName: list.name,
          completedAt: new Date(),
          items: {
            create: list.items.map((item) => ({
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

      await tx.item.deleteMany({ where: { listId: list.id } });

      return createdHistory;
    });

    return NextResponse.json(history);
  } catch (error) {
    console.error('Error completing list:', error);
    return NextResponse.json({ error: 'Failed to complete list' }, { status: 500 });
  }
}
