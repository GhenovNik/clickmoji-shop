import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request?: Request) {
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
    return NextResponse.json(
      { error: await apiText(request, 'fetchCategoriesFailed') },
      { status: 500 }
    );
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
        { error: await apiText(request, 'categoryFieldsRequired') },
        { status: 400 }
      );
    }

    // Either emoji or imageUrl must be provided
    if (!emoji && !imageUrl) {
      return NextResponse.json(
        { error: await apiText(request, 'categoryImageRequired') },
        { status: 400 }
      );
    }

    // Shift existing positions and create the category atomically.
    const category = await prisma.$transaction(async (tx) => {
      // Check whether the requested position is already occupied.
      const existingCategory = await tx.category.findFirst({
        where: { order },
      });

      if (existingCategory) {
        // Shift categories at and after the requested position.
        await tx.$executeRaw`
          UPDATE categories
          SET "order" = "order" + 1
          WHERE "order" >= ${order}
        `;
      }

      // Create the category at its final position.
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
    return NextResponse.json(
      { error: await apiText(request, 'createCategoryFailed') },
      { status: 500 }
    );
  }
}
