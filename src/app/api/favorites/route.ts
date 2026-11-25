import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { PRODUCT_OMIT } from '@/lib/catalog-omit';
import { requireUser } from '@/lib/auth-guards';
import { visibleProductsWhere } from '@/lib/product-visibility';

// The product of a favorite: its pictures come from the dictionary (the legacy column is omitted).
const productArgs = {
  omit: PRODUCT_OMIT,
  include: {
    category: {
      select: {
        id: true,
        name: true,
        nameEn: true,
        emoji: true,
      },
    },
  },
} as const;

const variantSelect = {
  id: true,
  name: true,
  nameEn: true,
  emoji: true,
  imageUrl: true,
  imageTextLocale: true,
  localizedImages: true,
} as const;

// GET /api/favorites - list the current user's favorite products and starred variants. A starred
// variant is a card of its own: it carries its parent product and a `variant`; a product favorite
// has `variant: null`. Both kinds come in one list, most used first.
export async function GET(request?: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const [products, variants] = await Promise.all([
      prisma.favorite.findMany({
        where: {
          userId: session.user.id,
          product: visibleProductsWhere(session.user.id),
        },
        include: { product: productArgs },
      }),
      prisma.variantFavorite.findMany({
        where: {
          userId: session.user.id,
          variant: { product: visibleProductsWhere(session.user.id) },
        },
        include: {
          variant: { select: { ...variantSelect, product: productArgs } },
        },
      }),
    ]);

    const favorites = [
      ...products.map((favorite) => ({ ...favorite, variant: null })),
      ...variants.map(
        ({ variant: { product, ...variant }, variantId: _variantId, ...favorite }) => ({
          ...favorite,
          productId: product.id,
          product,
          variant,
        })
      ),
    ].sort((a, b) => b.usageCount - a.usageCount);

    return NextResponse.json(favorites);
  } catch (error) {
    console.error('Error fetching favorites:', error);
    return NextResponse.json(
      { error: await apiText(request, 'fetchFavoritesFailed') },
      { status: 500 }
    );
  }
}

// POST /api/favorites - add a product (`productId`) or a variant (`variantId`) to favorites.
export async function POST(request: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { productId, variantId } = await request.json();

    if (variantId) {
      // The variant must exist and belong to a product the user can see.
      const variant = await prisma.productVariant.findFirst({
        where: { id: variantId, product: visibleProductsWhere(session.user.id) },
        select: { id: true },
      });
      if (!variant) {
        return NextResponse.json(
          { error: await apiText(request, 'productNotFound') },
          { status: 404 }
        );
      }

      const favorite = await prisma.variantFavorite.upsert({
        where: { userId_variantId: { userId: session.user.id, variantId } },
        update: { usageCount: { increment: 1 } },
        create: { userId: session.user.id, variantId, usageCount: 1 },
        select: { id: true, usageCount: true, variant: { select: variantSelect } },
      });
      return NextResponse.json(favorite);
    }

    if (!productId) {
      return NextResponse.json(
        { error: await apiText(request, 'productIdRequired') },
        { status: 400 }
      );
    }

    // Reject products that no longer exist or are another user's private product.
    const product = await prisma.product.findFirst({
      where: { id: productId, ...visibleProductsWhere(session.user.id) },
      select: { id: true },
    });

    if (!product) {
      return NextResponse.json(
        { error: await apiText(request, 'productNotFound') },
        { status: 404 }
      );
    }

    // Add the favorite or increment its usage counter.
    const favorite = await prisma.favorite.upsert({
      where: {
        userId_productId: {
          userId: session.user.id,
          productId,
        },
      },
      update: {
        usageCount: {
          increment: 1,
        },
      },
      create: {
        userId: session.user.id,
        productId,
        usageCount: 1,
      },
      include: { product: productArgs },
    });

    return NextResponse.json({ ...favorite, variant: null });
  } catch (error) {
    console.error('Error adding to favorites:', error);
    return NextResponse.json(
      { error: await apiText(request, 'addFavoriteFailed') },
      { status: 500 }
    );
  }
}

// DELETE /api/favorites - remove a product (`?productId=`) or a variant (`?variantId=`).
export async function DELETE(request: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { searchParams } = new URL(request.url);
    const productId = searchParams.get('productId');
    const variantId = searchParams.get('variantId');

    if (variantId) {
      // deleteMany: removing a star that is already gone is not an error.
      await prisma.variantFavorite.deleteMany({ where: { userId: session.user.id, variantId } });
      return NextResponse.json({ success: true });
    }

    if (!productId) {
      return NextResponse.json(
        { error: await apiText(request, 'productIdRequired') },
        { status: 400 }
      );
    }

    await prisma.favorite.delete({
      where: {
        userId_productId: {
          userId: session.user.id,
          productId,
        },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error removing from favorites:', error);
    return NextResponse.json(
      { error: await apiText(request, 'removeFavoriteFailed') },
      { status: 500 }
    );
  }
}
