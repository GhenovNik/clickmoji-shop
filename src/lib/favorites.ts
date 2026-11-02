import { localizedName } from '@/lib/catalog-name';
import { productImageUrl, type CatalogLocale } from '@/lib/product-image';

export type FavoriteVariant = {
  id: string;
  name: string;
  nameEn?: string | null;
  emoji: string;
  imageUrl: string | null;
  imageUrlEn?: string | null;
};

type FavoriteProductFields = {
  id: string;
  name: string;
  nameEn?: string | null;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  imageUrlEn?: string | null;
};

// One entry of GET /api/favorites: a product favorite has `variant: null`, a starred variant
// carries its parent product and the variant, and is a card of its own.
export type FavoriteEntry<P extends FavoriteProductFields = FavoriteProductFields> = {
  id: string;
  productId: string;
  usageCount?: number;
  product: P;
  variant?: FavoriteVariant | null;
};

// Product and variant ids come from different tables, so the key says which one it is.
export function favoriteKey(favorite: Pick<FavoriteEntry, 'product' | 'variant'>) {
  return favorite.variant ? `variant:${favorite.variant.id}` : `product:${favorite.product.id}`;
}

export function favoriteTarget(
  favorite: Pick<FavoriteEntry, 'product' | 'variant'>
): { variantId: string } | { productId: string } {
  return favorite.variant ? { variantId: favorite.variant.id } : { productId: favorite.product.id };
}

export function favoriteRemoveUrl(favorite: Pick<FavoriteEntry, 'product' | 'variant'>) {
  const params = new URLSearchParams(favoriteTarget(favorite) as Record<string, string>);
  return `/api/favorites?${params}`;
}

// The list item a favorite adds: a starred variant adds its product with that variant.
export function favoriteListItem(favorite: Pick<FavoriteEntry, 'product' | 'variant'>) {
  return { productId: favorite.product.id, variantId: favorite.variant?.id ?? null };
}

// What a favorite card shows: a variant shows its own name and picture (or emoji), falling back
// to the product's emoji when it has neither.
export function favoriteDisplay(
  favorite: Pick<FavoriteEntry, 'product' | 'variant'>,
  locale: CatalogLocale
) {
  const { product, variant } = favorite;
  if (variant) {
    return {
      name: localizedName(variant, locale),
      imageUrl: productImageUrl(variant, locale),
      emoji: variant.emoji || product.emoji,
      nameLang: locale === 'en' && variant.nameEn?.trim() ? 'en' : 'ru',
    };
  }
  return {
    name: localizedName(product, locale),
    imageUrl: product.isCustom ? productImageUrl(product, locale) : null,
    emoji: product.emoji,
    nameLang: locale === 'en' && product.nameEn?.trim() ? 'en' : 'ru',
  };
}
