'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { Product } from '@/hooks/useProductSelection';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';
import { productNameClassName } from './product-name';

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
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus belongs to the dialog's lifetime, not to changing callbacks or favorite state.
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      // All dialog actions are buttons. Read them on each keypress as favorites can rerender.
      const buttons = dialog.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled):not([tabindex="-1"])'
      );
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // z-[60]: above the mobile navigation bar (z-50), which would otherwise cover the sheet.
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('variantsTitle', { name: productName })}
        tabIndex={-1}
        className="w-full rounded-t-2xl bg-white p-4 pb-[max(2rem,env(safe-area-inset-bottom))] shadow-xl sm:max-w-md sm:rounded-2xl sm:pb-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
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
      </div>
    </div>
  );
}
