'use client';

import { useShoppingList } from '@/store/shopping-list';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function HistoryPage() {
  const history = useShoppingList((state) => state.history);
  const restoreFromHistory = useShoppingList((state) => state.restoreFromHistory);
  const deleteFromHistory = useShoppingList((state) => state.deleteFromHistory);
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleRestore = (historyId: string) => {
    restoreFromHistory(historyId);
    router.push('/shopping-list');
  };

  const handleDelete = (historyId: string) => {
    if (confirm('Удалить этот список из истории?')) {
      deleteFromHistory(historyId);
    }
  };

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">📜 История покупок</h1>
          <p className="text-gray-700">Ваши завершенные списки покупок</p>
        </div>

        {/* Empty State */}
        {history.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 shadow-lg text-center">
            <div className="text-6xl mb-4">🛒</div>
            <p className="text-gray-700 text-lg mb-4">История покупок пуста</p>
            <p className="text-gray-600 mb-6">
              Завершенные списки покупок будут отображаться здесь
            </p>
            <Link
              href="/categories"
              className="inline-block bg-blue-600 text-white px-6 py-3 rounded-xl hover:bg-blue-700 transition-colors"
            >
              Начать покупки
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {history.map((list) => {
              const isExpanded = expandedId === list.id;
              return (
                <div key={list.id} className="bg-white rounded-2xl shadow-lg overflow-hidden">
                  {/* List Header - Clickable */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : list.id)}
                    className="w-full p-6 flex items-center justify-between hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <span className="text-2xl">{isExpanded ? '📂' : '📁'}</span>
                      <div className="text-left">
                        <h3 className="text-lg font-semibold text-gray-900">
                          {formatDate(list.completedAt)}
                        </h3>
                        <p className="text-sm text-gray-600">
                          {list.items.length} {list.items.length === 1 ? 'товар' :
                           list.items.length < 5 ? 'товара' : 'товаров'}
                        </p>
                      </div>
                    </div>
                    <div className="text-gray-400 text-2xl">
                      {isExpanded ? '▼' : '▶'}
                    </div>
                  </button>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="px-6 pb-6 border-t border-gray-100">
                      {/* Action Buttons */}
                      <div className="flex gap-2 mb-4 pt-4">
                        <button
                          onClick={() => handleRestore(list.id)}
                          className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors font-semibold"
                        >
                          Восстановить
                        </button>
                        <button
                          onClick={() => handleDelete(list.id)}
                          className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors font-semibold"
                        >
                          Удалить
                        </button>
                      </div>

                      {/* Items List */}
                      <div className="space-y-2">
                        {list.items.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center gap-3 p-3 rounded-lg bg-gray-50"
                          >
                            <span className="text-2xl">{item.emoji}</span>
                            <div className="flex-1">
                              <p className="font-medium text-gray-900">{item.name}</p>
                              <p className="text-sm text-gray-600">{item.categoryName}</p>
                            </div>
                            {item.isPurchased && (
                              <span className="text-green-600 font-semibold">✓</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Back to Shopping List */}
        <div className="text-center mt-8">
          <Link
            href="/shopping-list"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            ← К списку покупок
          </Link>
        </div>
      </div>
    </div>
  );
}
