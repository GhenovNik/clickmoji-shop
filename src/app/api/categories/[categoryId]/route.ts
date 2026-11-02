import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';

// Replaced or deleted pictures are not removed from UploadThing here: between checking that
// nothing shows a file and deleting it, another request could attach the same URL again. A
// leftover file is cheap. `npm run db:files` removes leftovers, only with the app stopped; a
// protocol safe with writers running is AGE-1472.

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

    // Resolve position conflicts before updating the unique order field.
    if (order !== undefined) {
      const currentCategory = await prisma.category.findUnique({
        where: { id: categoryId },
      });

      if (currentCategory && currentCategory.order !== order) {
        // Swap category positions atomically.
        await prisma.$transaction(async (tx) => {
          // Find the category currently occupying the requested position.
          const conflictingCategory = await tx.category.findFirst({
            where: {
              order,
              id: { not: categoryId },
            },
          });

          if (conflictingCategory) {
            // Use a temporary negative value to avoid the unique constraint during the swap.
            await tx.category.update({
              where: { id: categoryId },
              data: { order: -1 },
            });

            // Move the conflicting category to the previous position.
            await tx.category.update({
              where: { id: conflictingCategory.id },
              data: { order: currentCategory.order },
            });

            // Move the current category into the requested position.
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
    return NextResponse.json(
      { error: await apiText(request, 'updateCategoryFailed') },
      { status: 500 }
    );
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

    // Delete category from database (cascade will delete products)
    await prisma.category.delete({
      where: { id: categoryId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting category:', error);
    return NextResponse.json(
      { error: await apiText(request, 'deleteCategoryFailed') },
      { status: 500 }
    );
  }
}
