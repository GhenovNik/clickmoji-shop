import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const body = await request.json();
    const { productIds, newCategoryId } = body;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return NextResponse.json({ error: 'productIds must be a non-empty array' }, { status: 400 });
    }

    if (!newCategoryId) {
      return NextResponse.json({ error: 'newCategoryId is required' }, { status: 400 });
    }

    // Проверяем, что целевая категория существует
    const targetCategory = await prisma.category.findUnique({
      where: { id: newCategoryId },
    });

    if (!targetCategory) {
      return NextResponse.json({ error: 'Target category not found' }, { status: 404 });
    }

    // Массово обновляем категорию для выбранных продуктов
    const result = await prisma.product.updateMany({
      where: {
        id: {
          in: productIds,
        },
      },
      data: {
        categoryId: newCategoryId,
      },
    });

    return NextResponse.json({
      success: true,
      movedCount: result.count,
      targetCategory: targetCategory.name,
    });
  } catch (error) {
    console.error('Error moving products to new category:', error);
    return NextResponse.json({ error: 'Failed to move products' }, { status: 500 });
  }
}
