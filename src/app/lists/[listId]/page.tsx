'use client';

import { use, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLists } from '@/store/lists';
import { useShoppingListItems } from '@/hooks/useShoppingListItems';
import ShoppingListItem from '@/components/shopping/ShoppingListItem';
import ShoppingListEmptyState from '@/components/shopping/ShoppingListEmptyState';
import ProductSearch from '@/components/ProductSearch';
import ImportListModal from '@/components/shopping/ImportListModal';

export default function ShoppingListPage({ params }: { params: Promise<{ listId: string }> }) {
  const router = useRouter();
  const { data: session } = useSession();
  const { setActiveList } = useLists();
  const { listId } = use(params);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const { list, items, loading, togglePurchased, removeItem, updateNote, clearAll, completeList } =
    useShoppingListItems(listId);

  useEffect(() => {
    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (!listId) return;
    setActiveList(listId);
  }, [session, router, listId, setActiveList]);

  if (loading || !session?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  const pendingItems = items.filter((item) => !item.isPurchased);
  const purchasedItems = items.filter((item) => item.isPurchased);

  // Группировка товаров по категориям
  const groupItemsByCategory = (itemsToGroup: typeof items) => {
    const grouped = itemsToGroup.reduce(
      (acc, item) => {
        const categoryId = item.product.category.name;
        if (!acc[categoryId]) {
          acc[categoryId] = {
            category: item.product.category,
            items: [],
          };
        }
        acc[categoryId].items.push(item);
        return acc;
      },
      {} as Record<
        string,
        {
          category: { name: string; emoji: string; order: number };
          items: typeof items;
        }
      >
    );

    // Сортировка категорий по полю order
    return Object.values(grouped).sort((a, b) => a.category.order - b.category.order);
  };

  const groupedPendingItems = groupItemsByCategory(pendingItems);
  const groupedPurchasedItems = groupItemsByCategory(purchasedItems);

  if (items.length === 0) {
    return <ShoppingListEmptyState listName={list?.name || 'Список'} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 pb-32">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 flex items-center justify-between gap-4">
          <Link
            href="/lists"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
          >
            <span>←</span>
            <span>К спискам</span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
          >
            <span>🏠</span>
            <span>На главную</span>
          </Link>
        </div>

        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">🛒 {list?.name || 'Список'}</h1>
          <p className="text-gray-700 mb-2">{pendingItems.length} товаров осталось купить</p>
          <p className="text-xs text-gray-500 mb-6">
            💡 Можно добавлять один товар несколько раз с разными заметками
          </p>

          {/* Search products */}
          <ProductSearch />

          {/* Import list button */}
          <button
            onClick={() => setIsImportModalOpen(true)}
            className="mt-4 bg-gradient-to-r from-green-500 to-teal-600 hover:from-green-600 hover:to-teal-700 text-white px-6 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 mx-auto"
          >
            <span>📋</span>
            <span>Импорт из текста</span>
          </button>
        </div>

        {pendingItems.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4 text-gray-900">Нужно купить</h2>
            {groupedPendingItems.map((group) => (
              <div key={group.category.name} className="mb-6">
                <h3 className="text-lg font-medium mb-3 text-gray-800 flex items-center gap-2">
                  <span className="text-2xl">{group.category.emoji}</span>
                  <span>{group.category.name}</span>
                </h3>
                <div className="space-y-3">
                  {group.items.map((item) => (
                    <ShoppingListItem
                      key={item.id}
                      item={item}
                      onToggle={togglePurchased}
                      onRemove={removeItem}
                      onUpdateNote={updateNote}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {purchasedItems.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4 text-gray-900">
              Куплено ({purchasedItems.length})
            </h2>
            {groupedPurchasedItems.map((group) => (
              <div key={group.category.name} className="mb-6">
                <h3 className="text-lg font-medium mb-3 text-gray-800 flex items-center gap-2">
                  <span className="text-2xl">{group.category.emoji}</span>
                  <span>{group.category.name}</span>
                </h3>
                <div className="space-y-3">
                  {group.items.map((item) => (
                    <ShoppingListItem
                      key={item.id}
                      item={item}
                      onToggle={togglePurchased}
                      onRemove={removeItem}
                      onUpdateNote={updateNote}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {pendingItems.length === 0 && purchasedItems.length > 0 && (
          <div className="mb-6">
            <button
              onClick={completeList}
              className="w-full bg-green-600 hover:bg-green-700 text-white px-8 py-4 rounded-xl font-bold text-lg transition-colors shadow-lg"
            >
              ✓ Завершить покупку
            </button>
            <p className="text-center text-sm text-gray-600 mt-2">
              Список будет сохранен в историю покупок
            </p>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex gap-4">
            <Link
              href={`/categories?listId=${listId}`}
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

        <div className="flex items-center justify-center gap-6 mt-8">
          <Link href="/history" className="text-blue-600 hover:text-blue-800 underline">
            История покупок
          </Link>
        </div>

        <ImportListModal
          listId={listId}
          isOpen={isImportModalOpen}
          onClose={() => setIsImportModalOpen(false)}
          onSuccess={() => {
            // Refresh will happen automatically after modal closes
          }}
        />
      </div>
    </div>
  );
}
