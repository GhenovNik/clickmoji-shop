import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { UTApi } from 'uploadthing/server';

const utapi = new UTApi();

// Extract file key from UploadThing URL
function getFileKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    return pathParts[pathParts.length - 1] || null;
  } catch {
    return null;
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ categoryId: string }> }
) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const { categoryId } = await params;
    const body = await request.json();
    const { name, nameEn, emoji, order, isCustom, imageUrl } = body;

    // If imageUrl is being changed, delete old file from UploadThing
    if (imageUrl !== undefined) {
      const currentCategory = await prisma.category.findUnique({
        where: { id: categoryId },
        select: { imageUrl: true },
      });

      if (currentCategory?.imageUrl && currentCategory.imageUrl !== imageUrl) {
        const oldFileKey = getFileKeyFromUrl(currentCategory.imageUrl);
        if (oldFileKey) {
          try {
            await utapi.deleteFiles(oldFileKey);
            console.log('🗑️ Deleted old category image:', oldFileKey);
          } catch (error) {
            console.error('Failed to delete old image from UploadThing:', error);
          }
        }
      }
    }

    // Если меняется order, нужно обработать конфликты с unique constraint
    if (order !== undefined) {
      const currentCategory = await prisma.category.findUnique({
        where: { id: categoryId },
      });

      if (currentCategory && currentCategory.order !== order) {
        // Используем транзакцию для атомарного обмена порядков
        await prisma.$transaction(async (tx) => {
          // Проверяем, занят ли новый order другой категорией
          const conflictingCategory = await tx.category.findFirst({
            where: {
              order,
              id: { not: categoryId },
            },
          });

          if (conflictingCategory) {
            // Swap порядков: меняем местами
            // 1. Временно устанавливаем отрицательное значение для текущей категории
            await tx.category.update({
              where: { id: categoryId },
              data: { order: -1 },
            });

            // 2. Устанавливаем старый order текущей категории для конфликтующей
            await tx.category.update({
              where: { id: conflictingCategory.id },
              data: { order: currentCategory.order },
            });

            // 3. Устанавливаем новый order для текущей категории
            await tx.category.update({
              where: { id: categoryId },
              data: { order },
            });
          }
        });
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
    return NextResponse.json({ error: 'Failed to update category' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ categoryId: string }> }
) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const { categoryId } = await params;

    // Get category to check if it has an image to delete
    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      select: { imageUrl: true, name: true },
    });

    // Delete category from database (cascade will delete products)
    await prisma.category.delete({
      where: { id: categoryId },
    });

    // Delete image from UploadThing if exists
    if (category?.imageUrl) {
      const fileKey = getFileKeyFromUrl(category.imageUrl);
      if (fileKey) {
        try {
          await utapi.deleteFiles(fileKey);
          console.log(`🗑️ Deleted image for category "${category.name}":`, fileKey);
        } catch (error) {
          console.error('Failed to delete image from UploadThing:', error);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting category:', error);
    return NextResponse.json({ error: 'Failed to delete category' }, { status: 500 });
  }
}
