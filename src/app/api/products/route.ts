import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { auth } from '@/lib/auth';

export async function GET(request: Request) {
  try {
    const session = await auth();
    const { searchParams } = new URL(request.url);
    const categoryId = searchParams.get('categoryId');

    const accessFilter = {
      OR: [{ isGlobal: true }, ...(session?.user?.id ? [{ createdById: session.user.id }] : [])],
    };

    if (!categoryId) {
      // Если categoryId не указан, возвращаем все продукты
      const products = await prisma.product.findMany({
        where: accessFilter,
        include: {
          variants: true,
          category: {
            select: {
              id: true,
              name: true,
              emoji: true,
              isCustom: true,
              imageUrl: true,
            },
          },
        },
        orderBy: {
          name: 'asc',
        },
      });
      return NextResponse.json(products);
    }

    const products = await prisma.product.findMany({
      where: {
        categoryId,
        ...accessFilter,
      },
      include: {
        variants: true,
        category: {
          select: {
            id: true,
            name: true,
            emoji: true,
            isCustom: true,
            imageUrl: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    return NextResponse.json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const body = await request.json();
    const { name, nameEn, emoji, categoryId, isCustom, imageUrl, variants } = body;

    // Валидация: emoji обязателен только если не используется кастомное изображение
    if (!name || !nameEn || !categoryId) {
      return NextResponse.json(
        { error: 'Missing required fields: name, nameEn, categoryId' },
        { status: 400 }
      );
    }

    if (!isCustom && !emoji) {
      return NextResponse.json(
        { error: 'Emoji is required for non-custom products' },
        { status: 400 }
      );
    }

    const product = await prisma.product.create({
      data: {
        name,
        nameEn,
        emoji,
        categoryId,
        isCustom: isCustom || false,
        imageUrl: imageUrl || null,
        variants: Array.isArray(variants)
          ? {
              create: variants
                .filter((variant) => variant?.name && variant?.nameEn)
                .map((variant) => ({
                  name: variant.name,
                  nameEn: variant.nameEn,
                  emoji: variant.emoji || '📦',
                })),
            }
          : undefined,
      },
      include: {
        variants: true,
        category: true,
      },
    });

    return NextResponse.json(product);
  } catch (error) {
    console.error('Error creating product:', error);
    return NextResponse.json({ error: 'Failed to create product' }, { status: 500 });
  }
}
