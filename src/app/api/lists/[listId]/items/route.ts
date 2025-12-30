import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';

// POST /api/lists/[listId]/items - добавить товары в список
export async function POST(request: Request, { params }: { params: Promise<{ listId: string }> }) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { listId } = await params;

    // Проверяем что список принадлежит пользователю
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

    // Добавляем товары в список
    // Используем createMany для добавления нескольких товаров сразу
    // Если товар уже есть в списке, пропускаем его (благодаря @@unique в схеме)
    const createdItems = [];
    const duplicates = [];

    for (const item of items) {
      try {
        const createdItem = await prisma.item.create({
          data: {
            listId: listId,
            productId: item.productId,
            variantId: item.variantId || null,
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
      } catch (error: unknown) {
        // Обрабатываем ошибки уникальности (товар уже в списке)
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code: string }).code === 'P2002'
        ) {
          // Получаем информацию о дубликате
          const product = await prisma.product.findUnique({
            where: { id: item.productId },
            select: { name: true, emoji: true },
          });
          duplicates.push(product);
        } else {
          throw error;
        }
      }
    }

    return NextResponse.json({
      createdItems,
      duplicates,
      message:
        duplicates.length > 0
          ? `Добавлено ${createdItems.length} товаров. ${duplicates.length} уже в списке.`
          : `Добавлено ${createdItems.length} товаров.`,
    });
  } catch (error) {
    console.error('Error adding items to list:', error);
    return NextResponse.json({ error: 'Failed to add items' }, { status: 500 });
  }
}
