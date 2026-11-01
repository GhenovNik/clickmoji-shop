import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { UTApi } from 'uploadthing/server';
import { isStoredImageInUse } from '@/lib/services/emoji-library';

const utapi = new UTApi();

// Extract file key from UploadThing URL
// Example: https://utfs.io/f/abc123.png -> abc123.png
function getFileKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    // UploadThing URLs are in format: https://utfs.io/f/{fileKey}
    const pathParts = urlObj.pathname.split('/');
    return pathParts[pathParts.length - 1] || null;
  } catch {
    return null;
  }
}

// Removes a replaced or orphaned picture from UploadThing unless something still shows it.
// Called only after the database change is committed, and without excluding the product: its
// other picture field may point at the same file. A failed delete never fails the request.
async function discardIfUnused(imageUrl: string | null | undefined) {
  if (!imageUrl || (await isStoredImageInUse(imageUrl))) return;
  const fileKey = getFileKeyFromUrl(imageUrl);
  if (!fileKey) return;
  try {
    await utapi.deleteFiles(fileKey);
  } catch (error) {
    console.error('Failed to delete image from UploadThing:', error);
  }
}

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

    // Pictures the update replaces; they are removed only once the update has committed.
    const previous =
      imageUrl !== undefined || imageUrlEn !== undefined
        ? await prisma.product.findUnique({
            where: { id: productId },
            select: { imageUrl: true, imageUrlEn: true },
          })
        : null;

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

    if (imageUrl !== undefined && previous?.imageUrl !== imageUrl) {
      await discardIfUnused(previous?.imageUrl);
    }
    if (imageUrlEn !== undefined && previous?.imageUrlEn !== imageUrlEn) {
      await discardIfUnused(previous?.imageUrlEn);
    }

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

    // Get product to check if it has an image to delete
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { imageUrl: true, imageUrlEn: true, name: true },
    });

    // Delete product from database
    await prisma.product.delete({
      where: { id: productId },
    });

    await discardIfUnused(product?.imageUrl);
    await discardIfUnused(product?.imageUrlEn);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting product:', error);
    return NextResponse.json({ error: 'Failed to delete product' }, { status: 500 });
  }
}
