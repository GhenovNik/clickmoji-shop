'use client';

import Image from 'next/image';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';
import Modal, { ModalBody, ModalFooter } from '@/components/ui/Modal';

interface Product {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  imageUrlEn?: string | null;
  categoryId: string;
}

interface Category {
  id: string;
  name: string;
  nameEn?: string | null;
  emoji: string;
}

interface ProductMoveModalProps {
  category: Category;
  products: Product[];
  allCategories: Category[];
  onClose: () => void;
  onMoveComplete: () => void;
}

export default function ProductMoveModal({
  category,
  products,
  allCategories,
  onClose,
  onMoveComplete,
}: ProductMoveModalProps) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [targetCategoryId, setTargetCategoryId] = useState('');
  const [moving, setMoving] = useState(false);

  const toggleProductSelection = (productId: string) => {
    setSelectedProductIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    );
  };

  const handleMoveProducts = async () => {
    if (selectedProductIds.length === 0) {
      alert(t('productMoveModal.selectAtLeastOne'));
      return;
    }

    if (!targetCategoryId) {
      alert(t('productMoveModal.selectTarget'));
      return;
    }

    setMoving(true);

    try {
      const res = await fetch('/api/products/move-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds: selectedProductIds,
          targetCategoryId,
        }),
      });

      if (res.ok) {
        alert(t('productMoveModal.moved'));
        onMoveComplete();
        onClose();
      } else {
        alert(t('productMoveModal.moveFailed'));
      }
    } catch (error) {
      console.error('Error moving products:', error);
      alert(t('productMoveModal.moveFailed'));
    } finally {
      setMoving(false);
    }
  };

  return (
    <Modal
      label={t('productMoveModal.title', {
        emoji: category.emoji,
        name: localizedName(category, locale),
      })}
      onClose={onClose}
      closeDisabled={moving}
      className="max-w-4xl"
    >
      <div className="modal-header border-b border-gray-200">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-900">
          {t('productMoveModal.title', {
            emoji: category.emoji,
            name: localizedName(category, locale),
          })}
        </h2>
        <p className="text-sm text-gray-500 mt-2">
          {t('productMoveModal.total', { count: products.length })}
        </p>
      </div>

      <ModalBody>
        {/* Products List */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-3">
            {t('productMoveModal.selectToMove')}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-96 overflow-y-auto">
            {products.map((product) => (
              <button
                key={product.id}
                onClick={() => toggleProductSelection(product.id)}
                className={`p-3 rounded-lg border-2 transition-all ${
                  selectedProductIds.includes(product.id)
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-blue-300'
                }`}
              >
                <div className="text-center">
                  {product.isCustom && productImageUrl(product, locale) ? (
                    <Image
                      src={productImageUrl(product, locale)!}
                      alt={localizedName(product, locale)}
                      width={48}
                      height={48}
                      className="w-12 h-12 object-contain mx-auto mb-2"
                      unoptimized
                    />
                  ) : (
                    <div className="text-3xl mb-2">{product.emoji}</div>
                  )}
                  <p className="text-xs font-medium text-gray-900 line-clamp-2">
                    {localizedName(product, locale)}
                  </p>
                </div>
                {selectedProductIds.includes(product.id) && (
                  <div className="mt-2 text-blue-600 text-sm font-semibold">
                    {t('productMoveModal.selected')}
                  </div>
                )}
              </button>
            ))}
          </div>
          {products.length === 0 && (
            <p className="text-center text-gray-500 py-8">{t('productMoveModal.empty')}</p>
          )}
        </div>

        {/* Target Category Selection */}
        {selectedProductIds.length > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="text-lg font-semibold text-blue-900 mb-3">
              {t('productMoveModal.moveTo', { count: selectedProductIds.length })}
            </h3>
            <select
              value={targetCategoryId}
              onChange={(e) => setTargetCategoryId(e.target.value)}
              className="w-full px-4 py-2 border border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
            >
              <option value="">{t('productMoveModal.selectCategoryOption')}</option>
              {allCategories
                .filter((cat) => cat.id !== category.id)
                .map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.emoji} {localizedName(cat, locale)}
                  </option>
                ))}
            </select>
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <div className="flex flex-col sm:flex-row gap-3">
          {selectedProductIds.length > 0 && targetCategoryId && (
            <button
              onClick={handleMoveProducts}
              disabled={moving}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {moving
                ? t('productMoveModal.moving')
                : t('productMoveModal.move', { count: selectedProductIds.length })}
            </button>
          )}
          <button
            onClick={onClose}
            disabled={moving}
            className="flex-1 sm:flex-none px-6 py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
          >
            {t('shared.close')}
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
