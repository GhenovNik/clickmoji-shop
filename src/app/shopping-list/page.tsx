'use client';

import Link from 'next/link';
import { useShoppingList } from '@/store/shopping-list';

export default function ShoppingListPage() {
  const { items, togglePurchased, removeItem, clearPurchased, clearAll, completeList } =
    useShoppingList();

  const pendingItems = items.filter((item) => !item.isPurchased);
  const purchasedItems = items.filter((item) => item.isPurchased);

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
        <div className="max-w-2xl mx-auto">
          {/* Back Button */}
          <div className="mb-6">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
            >
              <span>←</span>
              <span>На главную</span>
            </Link>
          </div>

          <div className="flex items-center justify-center" style={{ minHeight: 'calc(100vh - 200px)' }}>
            <div className="text-center">
              <div className="text-8xl mb-4">🛒</div>
              <h1 className="text-3xl font-bold mb-4 text-gray-900">
                Список покупок пуст
              </h1>
              <p className="text-gray-700 mb-8">
                Добавьте товары из категорий
              </p>
              <Link
                href="/categories"
                className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-semibold transition-colors"
              >
                Выбрать товары
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-2xl mx-auto">
        {/* Back Button */}
        <div className="mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
          >
            <span>←</span>
            <span>На главную</span>
          </Link>
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">
            🛒 Список покупок
          </h1>
          <p className="text-gray-700">
            {pendingItems.length} товаров осталось купить
          </p>
        </div>

        {/* Pending Items */}
        {pendingItems.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4 text-gray-900">
              Нужно купить
            </h2>
            <div className="space-y-3">
              {pendingItems.map((item) => (
                <div
                  key={item.id}
                  className="bg-white rounded-xl p-4 shadow-md flex items-center gap-4"
                >
                  <button
                    onClick={() => togglePurchased(item.id)}
                    className="w-8 h-8 rounded-full border-2 border-gray-300 hover:border-green-500 transition-colors flex-shrink-0"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-3xl">{item.emoji}</span>
                      <div>
                        <p className="font-medium text-gray-900">{item.name}</p>
                        <p className="text-sm text-gray-500">
                          {item.categoryName}
                        </p>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="text-red-500 hover:text-red-700 px-3 py-1 rounded transition-colors"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Purchased Items */}
        {purchasedItems.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-gray-900">
                Куплено ({purchasedItems.length})
              </h2>
              <button
                onClick={clearPurchased}
                className="text-sm text-red-600 hover:text-red-700 underline"
              >
                Очистить
              </button>
            </div>
            <div className="space-y-3">
              {purchasedItems.map((item) => (
                <div
                  key={item.id}
                  className="bg-white rounded-xl p-4 shadow-md flex items-center gap-4 opacity-60"
                >
                  <button
                    onClick={() => togglePurchased(item.id)}
                    className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0 hover:bg-green-600 transition-colors"
                  >
                    <span className="text-white text-xl">✓</span>
                  </button>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-3xl">{item.emoji}</span>
                      <div>
                        <p className="font-medium text-gray-900 line-through">
                          {item.name}
                        </p>
                        <p className="text-sm text-gray-500">
                          {item.categoryName}
                        </p>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="text-red-500 hover:text-red-700 px-3 py-1 rounded transition-colors"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="space-y-4">
          <div className="flex gap-4">
            <Link
              href="/categories"
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-semibold text-center transition-colors"
            >
              + Добавить товары
            </Link>
            {items.length > 0 && (
              <button
                onClick={clearAll}
                className="bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-xl font-semibold transition-colors"
              >
                Очистить всё
              </button>
            )}
          </div>

          {items.length > 0 && (
            <button
              onClick={() => {
                if (confirm('Завершить покупки и сохранить список в историю?')) {
                  completeList();
                }
              }}
              className="w-full bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-xl font-semibold transition-colors"
            >
              ✓ Завершить покупки
            </button>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-center gap-6 mt-8">
          <Link href="/history" className="text-blue-600 hover:text-blue-800 underline">
            История покупок
          </Link>
          <span className="text-gray-400">•</span>
          <Link href="/" className="text-blue-600 hover:text-blue-800 underline">
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
}
