import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';

// Replaced or deleted pictures are not removed from UploadThing here. Between checking that
// nothing shows a file and deleting it, another request could attach the same URL again, leaving
// a live product with a broken picture. A leftover file is cheap. `npm run db:files` removes
// leftovers, only with the app stopped; a protocol safe with writers running is AGE-1472.

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ productId: string }> }
) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const { productId } = await params;
    const body = await request.json();
    const { name, nameEn, emoji, categoryId, isCustom, imageUrl, imageUrlEn, variants } = body;

    const product = await prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.product.update({
        where: { id: productId },
        data: {
          ...(name && { name }),
          ...(nameEn && { nameEn }),
          ...(emoji && { emoji }),
          ...(categoryId && { categoryId }),
          ...(isCustom !== undefined && { isCustom }),
          ...(imageUrl !== undefined && { imageUrl }),
          ...(imageUrlEn !== undefined && { imageUrlEn: imageUrlEn || null }),
        },
      });

      if (Array.isArray(variants)) {
        const existingVariants = await tx.productVariant.findMany({
          where: { productId },
          select: { id: true },
        });

        const incoming = variants
          .filter((variant) => variant?.name && variant?.nameEn)
          .map((variant) => ({
            id: variant.id as string | undefined,
            name: variant.name as string,
            nameEn: variant.nameEn as string,
            emoji: variant.emoji as string | undefined,
          }));

        const incomingIds = new Set(incoming.map((variant) => variant.id).filter(Boolean));
        const toDelete = existingVariants.filter((variant) => !incomingIds.has(variant.id));

        for (const variant of toDelete) {
          const usedCount = await tx.item.count({ where: { variantId: variant.id } });
          if (usedCount === 0) {
            await tx.productVariant.delete({ where: { id: variant.id } });
          }
        }

        for (const variant of incoming) {
          if (variant.id) {
            await tx.productVariant.updateMany({
              where: { id: variant.id, productId },
              data: {
                name: variant.name,
                nameEn: variant.nameEn,
                emoji: variant.emoji || '📦',
              },
            });
          } else {
            await tx.productVariant.create({
              data: {
                name: variant.name,
                nameEn: variant.nameEn,
                emoji: variant.emoji || '📦',
                productId,
              },
            });
          }
        }
      }

      const updatedWithRelations = await tx.product.findUnique({
        where: { id: productId },
        include: { variants: true, category: true },
      });

      return updatedWithRelations ?? updatedProduct;
    });

    return NextResponse.json(product);
  } catch (error) {
    console.error('Error updating product:', error);
    return NextResponse.json({ error: 'Failed to update product' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ productId: string }> }
) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const { productId } = await params;

    await prisma.product.delete({
      where: { id: productId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting product:', error);
    return NextResponse.json({ error: 'Failed to delete product' }, { status: 500 });
  }
}
