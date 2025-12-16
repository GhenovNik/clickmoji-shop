import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ categoryId: string }> }
) {
  try {
    const session = await auth();
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { categoryId } = await params;
    const body = await request.json();
    const { name, nameEn, emoji, order, isCustom, imageUrl } = body;

    // Если меняется order, нужно обработать конфликты
    if (order !== undefined) {
      const currentCategory = await prisma.category.findUnique({
        where: { id: categoryId },
      });

      if (currentCategory && currentCategory.order !== order) {
        // Проверяем, занят ли новый order другой категорией
        const conflictingCategory = await prisma.category.findFirst({
          where: {
            order,
            id: { not: categoryId },
          },
        });

        if (conflictingCategory) {
          // Временно устанавливаем очень большой order для текущей категории
          await prisma.category.update({
            where: { id: categoryId },
            data: { order: 999999 },
          });

          // Сдвигаем все категории с order >= нового значения на +1
          await prisma.$executeRaw`
            UPDATE categories
            SET "order" = "order" + 1
            WHERE "order" >= ${order} AND id != ${categoryId}
          `;
        }
      }
    }

    const category = await prisma.category.update({
      where: { id: categoryId },
      data: {
        ...(name && { name }),
        ...(nameEn && { nameEn }),
        ...(emoji && { emoji }),
        ...(order !== undefined && { order }),
        ...(isCustom !== undefined && { isCustom }),
        ...(imageUrl !== undefined && { imageUrl }),
      },
    });

    return NextResponse.json(category);
  } catch (error) {
    console.error('Error updating category:', error);
    return NextResponse.json(
      { error: 'Failed to update category' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ categoryId: string }> }
) {
  try {
    const session = await auth();
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { categoryId } = await params;

    await prisma.category.delete({
      where: { id: categoryId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting category:', error);
    return NextResponse.json(
      { error: 'Failed to delete category' },
      { status: 500 }
    );
  }
}
