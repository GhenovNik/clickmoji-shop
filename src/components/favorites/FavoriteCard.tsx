'use client';

import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { FavoriteProduct } from '@/hooks/useFavorites';
import { productNameClassName } from '@/components/products/product-name';
import { LocalizedName } from '@/components/ui/LocalizedName';
import { localizedName, namesOf } from '@/lib/catalog-name';
import { favoriteDisplay, favoriteKey } from '@/lib/favorites';

interface FavoriteCardProps {
  favorite: FavoriteProduct;
  isSelected: boolean;
  onToggle: (key: string) => void;
  onRemove: (favorite: FavoriteProduct) => void;
}

export default function FavoriteCard({
  favorite,
  isSelected,
  onToggle,
  onRemove,
}: FavoriteCardProps) {
  const t = useTranslations('catalog.shared');
  const locale = useLocale();
  // A starred variant shows its own name and picture.
  const { entity, imageUrl, emoji } = favoriteDisplay(favorite, locale);
  const name = localizedName(entity, locale);

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(favorite);
  };

  return (
    <div className="relative">
      <button
        onClick={() => onToggle(favoriteKey(favorite))}
        className={`
          w-full bg-white rounded-2xl px-1.5 py-2.5 md:p-3 shadow-md transition-all
          ${isSelected ? 'ring-4 ring-green-500 scale-95' : 'hover:shadow-lg hover:scale-105'}
        `}
      >
        <div className="text-center">
          <div className="mx-auto mb-1 h-14 w-14 md:h-20 md:w-20 flex items-center justify-center overflow-hidden">
            {imageUrl ? (
              <Image
                src={imageUrl}
                alt={name}
                width={80}
                height={80}
                className="h-14 w-14 md:h-20 md:w-20 object-contain"
              />
            ) : (
              <span className="text-4xl md:text-6xl leading-none">{emoji}</span>
            )}
          </div>
          <LocalizedName
            names={namesOf(entity)}
            locale={locale}
            className="text-center"
            primaryClassName={productNameClassName(name)}
            secondaryClassName="truncate"
          />
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
