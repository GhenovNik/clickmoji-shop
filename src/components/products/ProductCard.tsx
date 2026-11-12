'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { Product } from '@/hooks/useProductSelection';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';
import { productNameClassName } from './product-name';
import VariantMenu from './VariantMenu';

interface ProductCardProps {
  product: Product;
  isSelected: boolean;
  isFavorite: boolean;
  showFavorite: boolean;
  selectedVariantId?: string | null;
  favoriteVariantIds?: ReadonlySet<string>;
  onToggle: (product: Product) => void;
  onSelectVariant?: (product: Product, variantId: string) => void;
  onToggleFavorite: (productId: string) => void;
  onToggleVariantFavorite?: (variantId: string) => void;
}

export default function ProductCard({
  product,
  isSelected,
  isFavorite,
  showFavorite,
  selectedVariantId,
  favoriteVariantIds,
  onToggle,
  onSelectVariant,
  onToggleFavorite,
  onToggleVariantFavorite,
}: ProductCardProps) {
  const t = useTranslations('catalog.shared');
  const locale = useLocale();
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const name = localizedName(product, locale);
  // Hyphenation follows the language the name is actually shown in (English falls back to Russian).
  const nameLang = locale === 'en' && product.nameEn?.trim() ? 'en' : 'ru';
  const imageUrl = productImageUrl(product, locale);
  const variants = product.variants ?? [];
  const pickedVariant = isSelected
    ? variants.find((variant) => variant.id === selectedVariantId)
    : undefined;

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleFavorite(product.id);
  };

  return (
    <div className="relative h-full">
      <button
        data-testid="product-card"
        onClick={() => onToggle(product)}
        className={`
          w-full h-[116px] md:h-[156px] bg-white rounded-2xl px-1.5 py-2.5 md:p-3 shadow-md transition-all
          ${isSelected ? 'ring-4 ring-green-500 scale-95' : 'hover:shadow-lg hover:scale-105'}
        `}
      >
        <div className="text-center">
          <div className="relative mx-auto mb-1 h-14 w-14 md:h-20 md:w-20 shrink-0 flex items-center justify-center overflow-hidden">
            {product.isCustom && imageUrl && !imageFailed ? (
              <>
                {!imageLoaded && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 flex items-center justify-center text-4xl md:text-6xl leading-none"
                  >
                    {product.emoji}
                  </span>
                )}
                <Image
                  src={imageUrl}
                  alt={name}
                  width={80}
                  height={80}
                  onLoad={() => setImageLoaded(true)}
                  onError={() => setImageFailed(true)}
                  className={`h-14 w-14 md:h-20 md:w-20 object-contain ${imageLoaded ? '' : 'opacity-0'}`}
                />
              </>
            ) : (
              <span className="text-4xl md:text-6xl leading-none">{product.emoji}</span>
            )}
          </div>
          <div className="h-[42px] flex items-center justify-center">
            <p lang={nameLang} className={productNameClassName(name)}>
              {name}
            </p>
          </div>
        </div>
      </button>

      {/* Variants stay out of the way: a small chip on the card's bottom edge opens them, and
          shows the picked one once a variant is in the selection. */}
      {variants.length > 0 && (
        <button
          type="button"
          onClick={() => setVariantsOpen(true)}
          aria-haspopup="dialog"
          className={`
            absolute -bottom-2 left-1/2 -translate-x-1/2 max-w-full truncate rounded-full border
            px-1.5 py-0.5 text-[10px] font-semibold leading-tight shadow-sm transition-colors
            ${
              pickedVariant
                ? 'border-green-500 bg-green-500 text-white'
                : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
            }
          `}
        >
          {pickedVariant
            ? localizedName(pickedVariant, locale)
            : t('variantsButton', { count: variants.length })}
        </button>
      )}

      {showFavorite && (
        <button
          onClick={handleFavoriteClick}
          className={`
            absolute -top-2 -right-2 w-8 h-8 rounded-full shadow-lg
            flex items-center justify-center transition-all
            ${isFavorite ? 'bg-yellow-400 hover:bg-yellow-500 scale-110' : 'bg-white hover:bg-yellow-100'}
          `}
          title={isFavorite ? t('removeFavorite') : t('addFavorite')}
        >
          <span className="text-xl">{isFavorite ? '⭐' : '☆'}</span>
        </button>
      )}

      {variantsOpen && (
        <VariantMenu
          product={product}
          pickedVariantId={pickedVariant?.id ?? null}
          favoriteVariantIds={favoriteVariantIds}
          showFavorite={showFavorite}
          onPick={(variantId) => {
            onSelectVariant?.(product, variantId);
            setVariantsOpen(false);
          }}
          onToggleFavorite={onToggleVariantFavorite}
          onClose={() => setVariantsOpen(false)}
        />
      )}
    </div>
  );
}
