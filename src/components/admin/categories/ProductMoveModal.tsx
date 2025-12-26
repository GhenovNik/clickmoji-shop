'use client';

import { useState } from 'react';

interface Product {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  categoryId: string;
}

interface Category {
  id: string;
  name: string;
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
      alert('Выберите хотя бы один продукт');
      return;
    }

    if (!targetCategoryId) {
      alert('Выберите целевую категорию');
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
        alert('✅ Продукты успешно перемещены!');
        onMoveComplete();
        onClose();
      } else {
        alert('Ошибка при перемещении продуктов');
      }
    } catch (error) {
      console.error('Error moving products:', error);
      alert('Ошибка при перемещении продуктов');
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 sm:p-6 border-b border-gray-200">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-900">
            {category.emoji} Управление товарами: {category.name}
          </h2>
          <p className="text-sm text-gray-500 mt-2">Всего товаров: {products.length}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* Products List */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">
              Выберите товары для перемещения:
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
                    {product.isCustom && product.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="w-12 h-12 object-contain mx-auto mb-2"
                      />
                    ) : (
                      <div className="text-3xl mb-2">{product.emoji}</div>
                    )}
                    <p className="text-xs font-medium text-gray-900 line-clamp-2">{product.name}</p>
                  </div>
                  {selectedProductIds.includes(product.id) && (
                    <div className="mt-2 text-blue-600 text-sm font-semibold">✓ Выбрано</div>
                  )}
                </button>
              ))}
            </div>
            {products.length === 0 && (
              <p className="text-center text-gray-500 py-8">В этой категории нет товаров</p>
            )}
          </div>

          {/* Target Category Selection */}
          {selectedProductIds.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <h3 className="text-lg font-semibold text-blue-900 mb-3">
                Переместить {selectedProductIds.length} товар(ов) в:
              </h3>
              <select
                value={targetCategoryId}
                onChange={(e) => setTargetCategoryId(e.target.value)}
                className="w-full px-4 py-2 border border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
              >
                <option value="">-- Выберите категорию --</option>
                {allCategories
                  .filter((cat) => cat.id !== category.id)
                  .map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.emoji} {cat.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-gray-200 bg-gray-50">
          <div className="flex flex-col sm:flex-row gap-3">
            {selectedProductIds.length > 0 && targetCategoryId && (
              <button
                onClick={handleMoveProducts}
                disabled={moving}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {moving ? '⏳ Перемещение...' : `✓ Переместить (${selectedProductIds.length})`}
              </button>
            )}
            <button
              onClick={onClose}
              disabled={moving}
              className="flex-1 sm:flex-none px-6 py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
            >
              Закрыть
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
