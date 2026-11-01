'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { localizedName } from '@/lib/catalog-name';

interface AddProductModalProps {
  categoryId: string;
  categoryName: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (product: SmartCreateProduct) => void;
}

type SmartCreateProduct = {
  id: string;
  name: string;
  emoji: string;
  nameEn?: string | null;
  categoryId?: string;
  isCustom?: boolean;
  imageUrl?: string | null;
};

export default function AddProductModal({
  categoryId,
  categoryName,
  isOpen,
  onClose,
  onSuccess,
}: AddProductModalProps) {
  const [productName, setProductName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const t = useTranslations('catalog');
  const tCommon = useTranslations('common');
  const locale = useLocale();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!productName.trim()) {
      setError(t('addProduct.nameRequired'));
      return;
    }

    setIsCreating(true);

    try {
      const res = await fetch('/api/products/smart-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: productName.trim(),
          categoryId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || t('addProduct.createFailed'));
      }

      const createdName = localizedName(data.product, locale);
      if (data.exists) {
        alert(t('addProduct.exists', { name: createdName }));
      } else {
        let message = t('addProduct.created', { name: createdName });
        if (data.customEmojiGenerated) {
          message += ` ${t('shared.uniqueImage')}`;
        } else {
          message += ` ${data.product.emoji}`;
        }
        if (data.aiSuggestion?.reasoning) {
          message += `\n\n${data.aiSuggestion.reasoning}`;
        }
        alert(message);
      }

      if (onSuccess) {
        onSuccess(data.product);
      }

      setProductName('');
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('addProduct.genericError'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    setProductName('');
    setError('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">{t('addProduct.title')}</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <p className="text-gray-600 mb-4">
          {t.rich('addProduct.category', {
            category: categoryName,
            name: (chunks) => <span className="font-semibold">{chunks}</span>,
          })}
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="productName" className="block text-sm font-medium text-gray-700 mb-2">
              {t('addProduct.nameLabel')}
            </label>
            <input
              type="text"
              id="productName"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder={t('addProduct.namePlaceholder')}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900"
              autoFocus
              disabled={isCreating}
            />
            {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
          </div>

          <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg p-4 mb-4">
            <p className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
              <span>✨</span>
              <span>{t('addProduct.smartTitle')}</span>
            </p>
            <ul className="text-xs text-gray-600 space-y-1 ml-6">
              <li>• {t('addProduct.smartCategory')}</li>
              <li>• {t('addProduct.smartEmoji')}</li>
              <li>• {t('addProduct.smartImage')}</li>
            </ul>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={isCreating}
              className="flex-1 px-4 py-3 border-2 border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {tCommon('cancel')}
            </button>
            <button
              type="submit"
              disabled={isCreating || !productName.trim()}
              className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isCreating ? (
                <>
                  <span className="animate-spin">⏳</span>
                  <span>{t('addProduct.creating')}</span>
                </>
              ) : (
                <>
                  <span>✨</span>
                  <span>{t('addProduct.create')}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
