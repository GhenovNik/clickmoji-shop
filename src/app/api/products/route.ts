import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { PRODUCT_OMIT, VARIANT_OMIT } from '@/lib/catalog-omit';
import { auth } from '@/lib/auth';
import { visibleProductsWhere } from '@/lib/product-visibility';
import { getRequestLocale } from '@/lib/auth-security';
import { sortByDisplayedName } from '@/lib/catalog-sort';
import {
  legacyEnglishOf,
  localizedImagesForStorage,
  mergeLocalizedImages,
} from '@/lib/picture-storage';

export async function GET(request: Request) {
  try {
    const session = await auth();
    const { searchParams } = new URL(request.url);
    const categoryId = searchParams.get('categoryId');

    const accessFilter = visibleProductsWhere(session?.user?.id);
    const locale = getRequestLocale(request);

    if (!categoryId) {
      // Return the full visible catalog when no category is selected.
      const products = await prisma.product.findMany({
        where: accessFilter,
        omit: PRODUCT_OMIT,
        include: {
          variants: { omit: VARIANT_OMIT },
          category: {
            select: {
              id: true,
              name: true,
              nameEn: true,
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
      return NextResponse.json(sortByDisplayedName(products, locale));
    }

    const products = await prisma.product.findMany({
      where: {
        categoryId,
        ...accessFilter,
      },
      omit: PRODUCT_OMIT,
      include: {
        variants: { omit: VARIANT_OMIT },
        category: {
          select: {
            id: true,
            name: true,
            nameEn: true,
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

    return NextResponse.json(sortByDisplayedName(products, locale));
  } catch (error) {
    console.error('Error fetching products:', error);
    return NextResponse.json(
      { error: await apiText(request, 'fetchProductsFailed') },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

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

    // An emoji is required unless a custom image is supplied.
    if (!name || !nameEn || !categoryId) {
      return NextResponse.json(
        { error: await apiText(request, 'productFieldsRequired') },
        { status: 400 }
      );
    }

    if (!isCustom && !emoji) {
      return NextResponse.json(
        { error: await apiText(request, 'productEmojiRequired') },
        { status: 400 }
      );
    }

    // A new product has no stored dictionary: only the listed picture languages are accepted.
    const pictures = mergeLocalizedImages(null, localizedImages);
    const product = await prisma.product.create({
      data: {
        name,
        nameEn,
        emoji,
        categoryId,
        isCustom: isCustom || false,
        imageUrl: imageUrl || null,
        imageTextLocale: imageTextLocale || null,
        localizedImages: localizedImagesForStorage(pictures),
        imageUrlEn: legacyEnglishOf(pictures),
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
      omit: PRODUCT_OMIT,
      include: {
        variants: { omit: VARIANT_OMIT },
        category: true,
      },
    });

    return NextResponse.json(product);
  } catch (error) {
    console.error('Error creating product:', error);
    return NextResponse.json(
      { error: await apiText(request, 'createProductFailed') },
      { status: 500 }
    );
  }
}
