import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET() {
  try {
    const categories = await prisma.category.findMany({
      orderBy: {
        order: 'asc',
      },
      include: {
        _count: {
          select: {
            products: true,
          },
        },
      },
    });

    return NextResponse.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const body = await request.json();
    const { name, nameEn, emoji, order, isCustom, imageUrl } = body;

    if (!name || !nameEn || order === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: name, nameEn, order' },
        { status: 400 }
      );
    }

    // Either emoji or imageUrl must be provided
    if (!emoji && !imageUrl) {
      return NextResponse.json(
        { error: 'Either emoji or custom image (imageUrl) is required' },
        { status: 400 }
      );
    }

    // Выполняем сдвиг и создание в транзакции
    const category = await prisma.$transaction(async (tx) => {
      // Проверяем, занят ли этот order
      const existingCategory = await tx.category.findFirst({
        where: { order },
      });

      if (existingCategory) {
        // Сдвигаем все категории с order >= указанного на +1
        await tx.$executeRaw`
          UPDATE categories
          SET "order" = "order" + 1
          WHERE "order" >= ${order}
        `;
      }

      // Создаём новую категорию
      return await tx.category.create({
        data: {
          name,
          nameEn,
          emoji,
          order,
          isCustom: isCustom || false,
          imageUrl: imageUrl || null,
        },
      });
    });

    return NextResponse.json(category);
  } catch (error) {
    console.error('Error creating category:', error);
    return NextResponse.json({ error: 'Failed to create category' }, { status: 500 });
  }
}
