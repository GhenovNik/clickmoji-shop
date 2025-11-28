'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLists, type List } from '@/store/lists';

type Item = {
  id: string;
  isPurchased: boolean;
  product: {
    id: string;
    name: string;
    emoji: string;
    category: {
      name: string;
    };
  };
};

export default function ShoppingListPage({ params }: { params: { listId: string } }) {
  const router = useRouter();
  const { data: session } = useSession();
  const { setLists, setActiveList } = useLists();
  const listId = params.listId;

  const [list, setList] = useState<any>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  // Load list and items
  useEffect(() => {
    if (!session?.user) {
      router.push('/auth/signin');
      return;
    }

    if (!listId) return;

    // Set as active list
    setActiveList(listId);

    // Load list details
    fetchListItems();
  }, [session, router, listId]);

  const fetchListItems = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/lists/${listId}`);
      if (response.ok) {
        const data = await response.json();
        setList(data);
        setItems(data.items || []);
      }
    } catch (error) {
      console.error('Error fetching list items:', error);
    } finally {
      setLoading(false);
    }
  };

  const togglePurchased = async (itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    // Optimistic update
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId ? { ...i, isPurchased: !i.isPurchased } : i
      )
    );

    try {
      await fetch(`/api/lists/${listId}/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPurchased: !item.isPurchased }),
      });
    } catch (error) {
      console.error('Error toggling item:', error);
      // Revert on error
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId ? { ...i, isPurchased: item.isPurchased } : i
        )
      );
    }
  };

  const removeItem = async (itemId: string) => {

    // Optimistic update
    setItems((prev) => prev.filter((i) => i.id !== itemId));

    try {
      await fetch(`/api/lists/${listId}/items/${itemId}`, {
        method: 'DELETE',
      });
      fetchListItems(); // Refresh items
    } catch (error) {
      console.error('Error removing item:', error);
      fetchListItems();
    }
  };

  const clearPurchased = async () => {
    const purchasedItems = items.filter((item) => item.isPurchased);
    for (const item of purchasedItems) {
      await removeItem(item.id);
    }
  };

  const clearAll = async () => {
    if (!confirm('Удалить все товары из списка?')) return;
    for (const item of items) {
      await removeItem(item.id);
    }
  };

  if (loading || !session?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  const pendingItems = items.filter((item) => !item.isPurchased);
  const purchasedItems = items.filter((item) => item.isPurchased);

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
        <div className="max-w-2xl mx-auto">
          {/* Back Button */}
          <div className="mb-6">
            <Link
              href="/lists"
              className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
            >
              <span>←</span>
              <span>К спискам</span>
            </Link>
          </div>

          <div
            className="flex items-center justify-center"
            style={{ minHeight: 'calc(100vh - 200px)' }}
          >
            <div className="text-center">
              <div className="text-8xl mb-4">🛒</div>
              <h1 className="text-3xl font-bold mb-4 text-gray-900">
                {list?.name || 'Список'} пуст
              </h1>
              <p className="text-gray-700 mb-8">Добавьте товары из категорий</p>
              <Link
                href="/categories"
                className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-semibold transition-colors"
              >
                Добавить товары
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 pb-32">
      <div className="max-w-2xl mx-auto">
        {/* Back Button */}
        <div className="mb-6">
          <Link
            href="/lists"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
          >
            <span>←</span>
            <span>К спискам</span>
          </Link>
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">🛒 {list?.name || 'Список'}</h1>
          <p className="text-gray-700">
            {pendingItems.length} товаров осталось купить
          </p>
        </div>

        {/* Pending Items */}
        {pendingItems.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4 text-gray-900">Нужно купить</h2>
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
                      <span className="text-3xl">{item.product.emoji}</span>
                      <div>
                        <p className="font-medium text-gray-900">{item.product.name}</p>
                        <p className="text-sm text-gray-500">
                          {item.product.category.name}
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
                      <span className="text-3xl">{item.product.emoji}</span>
                      <div>
                        <p className="font-medium text-gray-900 line-through">
                          {item.product.name}
                        </p>
                        <p className="text-sm text-gray-500">
                          {item.product.category.name}
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
