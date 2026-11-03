'use client';

import { use, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { localizedName } from '@/lib/catalog-name';
import { useLists } from '@/store/lists';
import { useShoppingListItems } from '@/hooks/useShoppingListItems';
import { useShoppingListFocus } from '@/hooks/useShoppingListFocus';
import ShoppingListItem from '@/components/shopping/ShoppingListItem';
import ShoppingListEmptyState from '@/components/shopping/ShoppingListEmptyState';
import ProductSearch from '@/components/ProductSearch';
import ImportListModal from '@/components/shopping/ImportListModal';
import { openModalFromTrigger } from '@/components/ui/Modal';

export default function ShoppingListPage({ params }: { params: Promise<{ listId: string }> }) {
  const router = useRouter();
  const { data: session, status } = useSession();
  const { setActiveList } = useLists();
  const { listId } = use(params);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const t = useTranslations('lists');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { rememberFocus, registerTarget } = useShoppingListFocus();

  const { list, items, loading, togglePurchased, removeItem, updateNote, clearAll, completeList } =
    useShoppingListItems(listId);

  const handleToggle = async (itemId: string) => {
    try {
      await togglePurchased(itemId);
    } catch (error) {
      // The mutation hook has already rolled the cache back. Consume the rejected
      // UI action; focus follows DOM commits, never the network promise.
      console.error('Error toggling purchased item:', error);
    }
  };

  useEffect(() => {
    if (status === 'loading') {
      return;
    }

    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (!listId) return;
    setActiveList(listId);
  }, [session, status, router, listId, setActiveList]);

  if (status === 'loading' || loading || !session?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl">{tCommon('loading')}</div>
      </div>
    );
  }

  const pendingItems = items.filter((item) => !item.isPurchased);
  const purchasedItems = items.filter((item) => item.isPurchased);

  // Group products by category for the shopping view.
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
          category: { name: string; nameEn?: string | null; emoji: string; order: number };
          items: typeof items;
        }
      >
    );

    // Preserve the catalog-defined category order.
    return Object.values(grouped).sort((a, b) => a.category.order - b.category.order);
  };

  const groupedPendingItems = groupItemsByCategory(pendingItems);
  const groupedPurchasedItems = groupItemsByCategory(purchasedItems);

  return (
    <>
      {items.length === 0 ? (
        <ShoppingListEmptyState
          listName={list?.name || t('listPage.listFallback')}
          onImport={() => setIsImportModalOpen(true)}
        />
      ) : (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 pb-32">
          <div className="max-w-2xl mx-auto">
            <div className="mb-6 hidden sm:flex items-center justify-between gap-4">
              <Link
                href="/lists"
                className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
              >
                <span>←</span>
                <span>{t('listPage.backToLists')}</span>
              </Link>
            </div>

            <div className="text-center mb-8">
              <h1 className="text-4xl font-bold mb-2 text-gray-900">
                🛒 {list?.name || t('listPage.listFallback')}
              </h1>
              <p className="text-gray-700 mb-2">
                {t('listPage.itemsLeft', { count: pendingItems.length })}
              </p>
              <p className="text-xs text-gray-500 mb-6">{t('listPage.duplicateHint')}</p>

              {/* Search products */}
              <ProductSearch />

              {/* Import list button */}
              <button
                onClick={openModalFromTrigger(() => setIsImportModalOpen(true))}
                className="mt-4 bg-gradient-to-r from-green-500 to-teal-600 hover:from-green-600 hover:to-teal-700 text-white px-6 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 mx-auto"
              >
                <span>📋</span>
                <span>{t('listPage.importFromText')}</span>
              </button>
            </div>

            {pendingItems.length > 0 && (
              <div className="mb-8">
                <h2 className="text-xl font-semibold mb-4 text-gray-900">{t('listPage.toBuy')}</h2>
                {groupedPendingItems.map((group) => (
                  <div key={group.category.name} className="mb-6">
                    <h3 className="text-lg font-medium mb-3 text-gray-800 flex items-center gap-2">
                      <span className="text-2xl">{group.category.emoji}</span>
                      <span>{localizedName(group.category, locale)}</span>
                    </h3>
                    <div className="space-y-3">
                      {group.items.map((item) => (
                        <ShoppingListItem
                          key={item.id}
                          item={item}
                          onToggle={handleToggle}
                          toggleButtonRef={(node) => registerTarget(item.id, node)}
                          onToggleFocus={(event) => rememberFocus(item.id, event.currentTarget)}
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
                  {t('listPage.purchased', { count: purchasedItems.length })}
                </h2>
                {groupedPurchasedItems.map((group) => (
                  <div key={group.category.name} className="mb-6">
                    <h3 className="text-lg font-medium mb-3 text-gray-800 flex items-center gap-2">
                      <span className="text-2xl">{group.category.emoji}</span>
                      <span>{localizedName(group.category, locale)}</span>
                    </h3>
                    <div className="space-y-3">
                      {group.items.map((item) => (
                        <ShoppingListItem
                          key={item.id}
                          item={item}
                          onToggle={handleToggle}
                          toggleButtonRef={(node) => registerTarget(item.id, node)}
                          onToggleFocus={(event) => rememberFocus(item.id, event.currentTarget)}
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
                  {t('listPage.completePurchase')}
                </button>
                <p className="text-center text-sm text-gray-600 mt-2">
                  {t('listPage.completeHint')}
                </p>
              </div>
            )}

            <div className="space-y-4">
              <div className="flex gap-4">
                <Link
                  href={`/categories?listId=${listId}`}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-semibold text-center transition-colors"
                >
                  {t('listPage.addProducts')}
                </Link>
                {items.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-xl font-semibold transition-colors"
                  >
                    {t('listPage.clearAll')}
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-center gap-6 mt-8">
              <Link href="/history" className="text-blue-600 hover:text-blue-800 underline">
                {t('listPage.history')}
              </Link>
            </div>
          </div>
        </div>
      )}

      <ImportListModal
        listId={listId}
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSuccess={() => {
          // Refresh will happen automatically after modal closes
        }}
      />
    </>
  );
}
