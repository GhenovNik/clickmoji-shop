'use client';

import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { Product } from '@/hooks/useProductSelection';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';
import { productNameClassName } from './product-name';

interface ProductCardProps {
  product: Product;
  isSelected: boolean;
  isFavorite: boolean;
  showFavorite: boolean;
  selectedVariantId?: string | null;
  onToggle: (product: Product) => void;
  onVariantChange?: (productId: string, variantId: string | null) => void;
  onToggleFavorite: (productId: string) => void;
}

export default function ProductCard({
  product,
  isSelected,
  isFavorite,
  showFavorite,
  selectedVariantId,
  onToggle,
  onVariantChange,
  onToggleFavorite,
}: ProductCardProps) {
  const t = useTranslations('catalog.shared');
  const locale = useLocale();
  const name = localizedName(product, locale);
  // Hyphenation follows the language the name is actually shown in (English falls back to Russian).
  const nameLang = locale === 'en' && product.nameEn?.trim() ? 'en' : 'ru';
  const imageUrl = productImageUrl(product, locale);

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
          <div className="mx-auto mb-1 h-14 w-14 md:h-20 md:w-20 shrink-0 flex items-center justify-center overflow-hidden">
            {product.isCustom && imageUrl ? (
              <Image
                src={imageUrl}
                alt={name}
                width={80}
                height={80}
                className="h-14 w-14 md:h-20 md:w-20 object-contain"
              />
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

      {product.variants && product.variants.length > 0 && isSelected && (
        <div className="mt-2">
          <select
            value={selectedVariantId || ''}
            onChange={(event) => onVariantChange?.(product.id, event.target.value || null)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
          >
            <option value="">{t('noVariant')}</option>
            {product.variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.emoji ? `${variant.emoji} ` : ''}
                {localizedName(variant, locale)}
              </option>
            ))}
          </select>
        </div>
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
    </div>
  );
}
