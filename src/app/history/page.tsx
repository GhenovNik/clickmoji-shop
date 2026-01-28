'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

type HistoryItem = {
  id: string;
  productId: string | null;
  variantId: string | null;
  productName: string;
  productEmoji: string;
  productImageUrl: string | null;
  categoryName: string;
  isCustom: boolean;
  variantName: string | null;
  variantEmoji: string | null;
  note: string | null;
  isPurchased: boolean;
  addedAt: string;
};

type HistoryList = {
  id: string;
  listName: string;
  completedAt: string;
  items: HistoryItem[];
};

const fetchHistory = async (): Promise<HistoryList[]> => {
  const res = await fetch('/api/history');
  if (!res.ok) throw new Error('Failed to fetch history');
  return res.json();
};

export default function HistoryPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!session?.user) {
      router.push('/login');
    }
  }, [session, router]);

  const { data: history = [], isLoading } = useQuery({
    queryKey: ['history'],
    queryFn: fetchHistory,
    enabled: !!session?.user,
  });

  const handleRestore = async (historyId: string) => {
    if (!session?.user) {
      alert('Войдите в систему для восстановления списка');
      return;
    }

    const historyList = history.find((list) => list.id === historyId);
    if (!historyList) return;

    setRestoring(true);

    try {
      const listName = `Список от ${formatDate(historyList.completedAt)}`;

      const restoreResponse = await fetch(`/api/history/${historyId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: listName }),
      });

      if (!restoreResponse.ok) {
        throw new Error('Failed to restore history');
      }

      const { listId } = await restoreResponse.json();
      router.push(`/lists/${listId}`);
    } catch (error) {
      console.error('Error restoring list:', error);
      alert('Ошибка при восстановлении списка');
    } finally {
      setRestoring(false);
    }
  };

  const handleDelete = async (historyId: string) => {
    if (!confirm('Удалить этот список из истории?')) return;

    try {
      const res = await fetch(`/api/history/${historyId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete history');
      queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch (error) {
      console.error('Error deleting history:', error);
      alert('Не удалось удалить историю');
    }
  };

  const formatDate = (date: string) => {
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
          <h1 className="text-4xl font-bold mb-2 text-gray-900">📜 История покупок</h1>
          <p className="text-gray-700">Ваши завершенные списки покупок</p>
        </div>

        {/* Empty State */}
        {isLoading ? (
          <div className="text-center text-gray-500">Загрузка...</div>
        ) : history.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 shadow-lg text-center">
            <div className="text-6xl mb-4">🛒</div>
            <p className="text-gray-700 text-lg mb-4">История покупок пуста</p>
            <p className="text-gray-600 mb-6">
              Завершенные списки покупок будут отображаться здесь
            </p>
            <Link
              href="/lists"
              className="inline-block bg-blue-600 text-white px-6 py-3 rounded-xl hover:bg-blue-700 transition-colors"
            >
              К спискам покупок
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
                          {list.items.length}{' '}
                          {list.items.length === 1
                            ? 'товар'
                            : list.items.length < 5
                              ? 'товара'
                              : 'товаров'}
                        </p>
                      </div>
                    </div>
                    <div className="text-gray-400 text-2xl">{isExpanded ? '▼' : '▶'}</div>
                  </button>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="px-6 pb-6 border-t border-gray-100">
                      {/* Action Buttons */}
                      <div className="flex gap-2 mb-4 pt-4">
                        <button
                          onClick={() => handleRestore(list.id)}
                          disabled={restoring}
                          className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors font-semibold disabled:opacity-50"
                        >
                          {restoring ? 'Восстановление...' : 'Восстановить в новый список'}
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
                            {item.isCustom && item.productImageUrl ? (
                              <img
                                src={item.productImageUrl}
                                alt={item.productName}
                                className="w-8 h-8 object-contain"
                              />
                            ) : (
                              <span className="text-2xl">{item.productEmoji}</span>
                            )}
                            <div className="flex-1">
                              <p className="font-medium text-gray-900">
                                {item.productName}
                                {item.variantName && (
                                  <span className="text-sm text-gray-600">
                                    {' '}
                                    - {item.variantName}
                                  </span>
                                )}
                              </p>
                              <p className="text-sm text-gray-600">{item.categoryName}</p>
                              {item.note && <p className="text-xs text-gray-500">{item.note}</p>}
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
      </div>
    </div>
  );
}
