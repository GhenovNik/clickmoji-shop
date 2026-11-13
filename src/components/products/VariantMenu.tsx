'use client';

import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { Product } from '@/hooks/useProductSelection';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';
import { productNameClassName } from './product-name';
import Modal, { ModalBody, ModalFooter } from '@/components/ui/Modal';

interface VariantMenuProps {
  product: Product;
  pickedVariantId: string | null;
  favoriteVariantIds?: ReadonlySet<string>;
  showFavorite: boolean;
  onPick: (variantId: string) => void;
  onToggleFavorite?: (variantId: string) => void;
  onClose: () => void;
}

// The variants of one product (Honeycrisp for an apple). A bottom sheet on a phone, a dialog on
// a wider screen. Picking a variant adds the product with it; a starred variant becomes a card
// of its own among the favorites.
export default function VariantMenu({
  product,
  pickedVariantId,
  favoriteVariantIds,
  showFavorite,
  onPick,
  onToggleFavorite,
  onClose,
}: VariantMenuProps) {
  const t = useTranslations('catalog.shared');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const productName = localizedName(product, locale);
  const productImage = product.isCustom ? productImageUrl(product, locale) : null;

  return (
    <Modal
      label={t('variantsTitle', { name: productName })}
      onClose={onClose}
      sheet
      className="sm:max-w-md"
    >
      <div className="modal-header flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-gray-900">
          {t('variantsTitle', { name: productName })}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={tCommon('close')}
          className="text-2xl leading-none text-gray-400 hover:text-gray-600"
        >
          ×
        </button>
      </div>

      <ModalBody>
        <div className="grid grid-cols-3 gap-3">
          {(product.variants ?? []).map((variant) => {
            const name = localizedName(variant, locale);
            const nameLang = locale === 'en' && variant.nameEn?.trim() ? 'en' : 'ru';
            // A variant without a picture or emoji of its own shows the product's.
            const variantImage = productImageUrl(
              { imageUrl: variant.imageUrl ?? null, imageUrlEn: variant.imageUrlEn },
              locale
            );
            const image = variantImage || (variant.emoji ? null : productImage);
            const emoji = variant.emoji || product.emoji;
            const picked = variant.id === pickedVariantId;
            const starred = favoriteVariantIds?.has(variant.id) ?? false;

            return (
              <div key={variant.id} className="relative">
                <button
                  type="button"
                  data-testid="variant-card"
                  aria-pressed={picked}
                  onClick={() => onPick(variant.id)}
                  className={`
                    h-[116px] w-full rounded-2xl bg-white px-1.5 py-2.5 shadow-md transition-all
                    ${picked ? 'ring-4 ring-green-500' : 'ring-1 ring-gray-100 hover:shadow-lg'}
                  `}
                >
                  <div className="mx-auto mb-1 flex h-14 w-14 items-center justify-center overflow-hidden">
                    {image ? (
                      <Image
                        src={image}
                        alt={name}
                        width={56}
                        height={56}
                        className="h-14 w-14 object-contain"
                      />
                    ) : (
                      <span className="text-4xl leading-none">{emoji}</span>
                    )}
                  </div>
                  <div className="flex h-[42px] items-center justify-center">
                    <p lang={nameLang} className={productNameClassName(name)}>
                      {name}
                    </p>
                  </div>
                </button>

                {showFavorite && onToggleFavorite && (
                  <button
                    type="button"
                    onClick={() => onToggleFavorite(variant.id)}
                    title={starred ? t('removeFavorite') : t('addFavorite')}
                    className={`
                      absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full
                      shadow-lg transition-all
                      ${starred ? 'bg-yellow-400 hover:bg-yellow-500' : 'bg-white hover:bg-yellow-100'}
                    `}
                  >
                    <span className="text-base">{starred ? '⭐' : '☆'}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-xl border px-4 py-3 font-semibold text-gray-700 hover:bg-gray-50"
        >
          {tCommon('cancel')}
        </button>
      </ModalFooter>
    </Modal>
  );
}
