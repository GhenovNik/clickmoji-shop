'use client';

import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { FavoriteProduct } from '@/hooks/useFavorites';
import { productNameClassName } from '@/components/products/product-name';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';

interface FavoriteCardProps {
  favorite: FavoriteProduct;
  isSelected: boolean;
  onToggle: (productId: string) => void;
  onRemove: (productId: string) => void;
}

export default function FavoriteCard({
  favorite,
  isSelected,
  onToggle,
  onRemove,
}: FavoriteCardProps) {
  const t = useTranslations('catalog.shared');
  const locale = useLocale();
  const { product } = favorite;
  const name = localizedName(product, locale);
  // Hyphenation follows the language the name is actually shown in (English falls back to Russian).
  const nameLang = locale === 'en' && product.nameEn?.trim() ? 'en' : 'ru';
  const imageUrl = productImageUrl(product, locale);

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(favorite.product.id);
  };

  return (
    <div className="relative">
      <button
        onClick={() => onToggle(favorite.product.id)}
        className={`
          w-full bg-white rounded-2xl p-4 shadow-md transition-all
          ${isSelected ? 'ring-4 ring-green-500 scale-95' : 'hover:shadow-lg hover:scale-105'}
        `}
      >
        <div className="text-center">
          <div className="mx-auto mb-2 h-16 w-16 flex items-center justify-center overflow-hidden">
            {product.isCustom && imageUrl ? (
              <Image
                src={imageUrl}
                alt={name}
                width={64}
                height={64}
                className="h-16 w-16 object-contain"
              />
            ) : (
              <span className="text-4xl leading-none">{favorite.product.emoji}</span>
            )}
          </div>
          <p lang={nameLang} className={productNameClassName(name)}>
            {name}
          </p>
        </div>
      </button>

      <button
        onClick={handleRemoveClick}
        className="absolute -top-2 -right-2 w-8 h-8 rounded-full shadow-lg bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-all"
        title={t('removeFavorite')}
      >
        <span className="text-lg">✕</span>
      </button>
    </div>
  );
}
