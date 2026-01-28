import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { UTApi } from 'uploadthing/server';

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

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ productId: string }> }
) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const { productId } = await params;
    const body = await request.json();
    const { name, nameEn, emoji, categoryId, isCustom, imageUrl, variants } = body;

    // If imageUrl is being changed, delete old file from UploadThing
    if (imageUrl !== undefined) {
      const currentProduct = await prisma.product.findUnique({
        where: { id: productId },
        select: { imageUrl: true },
      });

      if (currentProduct?.imageUrl && currentProduct.imageUrl !== imageUrl) {
        const oldFileKey = getFileKeyFromUrl(currentProduct.imageUrl);
        if (oldFileKey) {
          try {
            await utapi.deleteFiles(oldFileKey);
            console.log('🗑️ Deleted old product image:', oldFileKey);
          } catch (error) {
            console.error('Failed to delete old image from UploadThing:', error);
            // Continue anyway - DB update is more important
          }
        }
      }
    }

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
            await tx.productVariant.update({
              where: { id: variant.id },
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

    // Get product to check if it has an image to delete
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { imageUrl: true, name: true },
    });

    // Delete product from database
    await prisma.product.delete({
      where: { id: productId },
    });

    // Delete image from UploadThing if exists
    if (product?.imageUrl) {
      const fileKey = getFileKeyFromUrl(product.imageUrl);
      if (fileKey) {
        try {
          await utapi.deleteFiles(fileKey);
          console.log(`🗑️ Deleted image for product "${product.name}":`, fileKey);
        } catch (error) {
          console.error('Failed to delete image from UploadThing:', error);
          // Don't fail the request - product is already deleted
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting product:', error);
    return NextResponse.json({ error: 'Failed to delete product' }, { status: 500 });
  }
}
