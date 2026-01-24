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

    console.log('📥 Received items to add:', JSON.stringify(items, null, 2));

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Items array is required' }, { status: 400 });
    }

    // Добавляем товары в список
    // Теперь разрешаем дубликаты - можно добавлять один товар несколько раз с разными заметками
    const createdItems = [];

    for (const item of items) {
      console.log('🔍 Adding item:', item);

      // Проверяем, что productId существует
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
      console.log('✅ Item created:', createdItem.id);
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
