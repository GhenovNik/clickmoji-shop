import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { PRODUCT_OMIT, VARIANT_OMIT } from '@/lib/catalog-omit';
import {
  editsEnglish,
  legacyEnglishOf,
  localizedImagesForStorage,
  mergeLocalizedImages,
  pictureEditOf,
} from '@/lib/picture-storage';

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
    const {
      name,
      nameEn,
      emoji,
      categoryId,
      isCustom,
      imageUrl,
      imageTextLocale,
      localizedImages,
      variants,
    } = body;

    // `localizedImages` is an edit of the languages the admin touched (see `PictureEdit`), not the
    // whole dictionary. A body without a readable edit leaves every picture language alone.
    const pictureEdit = pictureEditOf(localizedImages);

    // One transaction: the picture languages, the mirror and the variants are saved together or
    // not at all, and a retry of the same request ends in the same state.
    const product = await prisma.$transaction(async (tx) => {
      let pictureData: Prisma.ProductUpdateInput = {};
      if (pictureEdit && Object.keys(pictureEdit).length > 0) {
        // The dictionary is read, changed and written back: hold the row so a concurrent edit of
        // another language cannot be overwritten by this one's stale copy.
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} FOR UPDATE`;
        const stored = await tx.product.findUnique({
          where: { id: productId },
          select: { localizedImages: true },
        });
        const pictures = mergeLocalizedImages(stored?.localizedImages, pictureEdit);
        pictureData = {
          localizedImages: localizedImagesForStorage(pictures),
          // The legacy English column is a rollback mirror of the English entry. It follows an
          // edit of English (a new picture, or an explicit removal) and is left as stored when
          // English is not in the edit: a row written by the previous release may keep its only
          // English address there until the backfill copies it into the dictionary.
          ...(editsEnglish(pictureEdit) && { imageUrlEn: legacyEnglishOf(pictures) }),
        };
      }
      const updatedProduct = await tx.product.update({
        where: { id: productId },
        omit: PRODUCT_OMIT,
        data: {
          ...(name && { name }),
          ...(nameEn && { nameEn }),
          ...(emoji && { emoji }),
          ...(categoryId && { categoryId }),
          ...(isCustom !== undefined && { isCustom }),
          ...(imageUrl !== undefined && { imageUrl }),
          ...(imageTextLocale !== undefined && { imageTextLocale: imageTextLocale || null }),
          ...pictureData,
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
        omit: PRODUCT_OMIT,
        include: { variants: { omit: VARIANT_OMIT }, category: true },
      });

      return updatedWithRelations ?? updatedProduct;
    });

    return NextResponse.json(product);
  } catch (error) {
    console.error('Error updating product:', error);
    return NextResponse.json(
      { error: await apiText(request, 'updateProductFailed') },
      { status: 500 }
    );
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
    return NextResponse.json(
      { error: await apiText(request, 'deleteProductFailed') },
      { status: 500 }
    );
  }
}
