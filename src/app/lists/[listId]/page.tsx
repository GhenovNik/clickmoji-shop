'use client';

import { use, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, LayoutGrid, List } from 'lucide-react';
import { useLists } from '@/store/lists';
import { useShoppingListItems } from '@/hooks/useShoppingListItems';
import { useShoppingListFocus } from '@/hooks/useShoppingListFocus';
import { useShoppingListPresentation } from '@/hooks/useShoppingListPresentation';
import ShoppingCategoryGroup from '@/components/shopping/ShoppingCategoryGroup';
import ShoppingListItem from '@/components/shopping/ShoppingListItem';
import ShoppingListEmptyState from '@/components/shopping/ShoppingListEmptyState';
import ProductSearch from '@/components/ProductSearch';
import ImportListModal from '@/components/shopping/ImportListModal';

export default function ShoppingListPage({ params }: { params: Promise<{ listId: string }> }) {
  const router = useRouter();
  const { data: session, status } = useSession();
  const { setActiveList } = useLists();
  const { listId } = use(params);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const t = useTranslations('lists');
  const tCommon = useTranslations('common');
  const { rememberFocus, registerTarget, isFocusTarget } = useShoppingListFocus();
  const { view, collapsed, setView, toggleGroup, expandGroups } = useShoppingListPresentation();

  const { list, items, loading, togglePurchased, removeItem, updateNote, clearAll, completeList } =
    useShoppingListItems(listId);

  const handleToggle = async (itemId: string) => {
    const item = items.find((entry) => entry.id === itemId);
    if (item && isFocusTarget(itemId)) {
      // A focused circle must remain reachable when it moves into a folded
      // section. The existing list-level intent still owns focus restoration.
      expandGroups([
        `${listId}:${item.isPurchased ? 'pending' : 'purchased'}:${item.product.category.name}`,
        ...(!item.isPurchased ? [`${listId}:purchased`] : []),
      ]);
    }
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
  const purchasedKey = `${listId}:purchased`;
  const purchasedExpanded = !collapsed.includes(purchasedKey);
  const PurchasedChevron = purchasedExpanded ? ChevronUp : ChevronDown;

  const renderGroups = (groups: typeof groupedPendingItems, purchased: boolean) =>
    groups.map((group) => {
      const key = `${listId}:${purchased ? 'purchased' : 'pending'}:${group.category.name}`;
      const groupView = purchased ? 'list' : view;
      return (
        <ShoppingCategoryGroup
          key={key}
          category={group.category}
          count={group.items.length}
          expanded={!collapsed.includes(key)}
          onToggle={() => toggleGroup(key)}
          view={groupView}
          purchased={purchased}
        >
          {group.items.map((item) => (
            <ShoppingListItem
              key={item.id}
              item={item}
              view={groupView}
              onToggle={handleToggle}
              toggleButtonRef={(node) => registerTarget(item.id, node)}
              onToggleFocus={(event) => rememberFocus(item.id, event.currentTarget)}
              onRemove={removeItem}
              onUpdateNote={updateNote}
            />
          ))}
        </ShoppingCategoryGroup>
      );
    });

  return (
    <>
      {items.length === 0 ? (
        <ShoppingListEmptyState
          listName={list?.name || t('listPage.listFallback')}
          onImport={() => setIsImportModalOpen(true)}
        />
      ) : (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 -mx-4 sm:mx-0 px-3 py-2 sm:p-5 pb-24 rounded-2xl">
          <div className="max-w-2xl mx-auto">
            <div className="mb-3 hidden sm:flex items-center justify-between gap-4">
              <Link
                href="/lists"
                className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
              >
                <span>←</span>
                <span>{t('listPage.backToLists')}</span>
              </Link>
            </div>

            <div className="mb-2">
              <div className="flex items-center justify-between gap-2">
                <h1 className="min-w-0 truncate text-xl sm:text-3xl font-bold text-gray-900">
                  🛒 {list?.name || t('listPage.listFallback')}
                </h1>
                <p className="shrink-0 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                  {t('listPage.itemsLeft', { count: pendingItems.length })}
                </p>
              </div>
              <p
                className="text-[10px] leading-3 sm:text-xs text-gray-500 truncate mt-1 mb-2"
                title={t('listPage.duplicateHint')}
              >
                {t('listPage.duplicateHint')}
              </p>

              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ProductSearch compact />
                </div>

                <button
                  type="button"
                  onClick={() => setIsImportModalOpen(true)}
                  className="shrink-0 w-28 sm:w-auto min-h-11 bg-gradient-to-r from-green-500 to-teal-600 hover:from-green-600 hover:to-teal-700 text-white px-2 sm:px-4 py-1 rounded-xl text-xs sm:text-sm font-semibold transition-all flex items-center justify-center gap-1"
                >
                  <span>📋</span>
                  <span>{t('listPage.importFromText')}</span>
                </button>
              </div>
            </div>

            {items.length > 0 && (
              <section
                aria-labelledby="shopping-to-buy"
                className="mb-3 rounded-2xl bg-white/30 p-1 space-y-1"
              >
                <div className="flex items-center justify-between gap-2 px-1">
                  <h2 id="shopping-to-buy" className="text-xl font-semibold text-gray-900">
                    {t('listPage.toBuy')}
                  </h2>
                  <div
                    role="group"
                    aria-label={t('listPage.viewLabel')}
                    className="inline-flex rounded-lg bg-white/60 p-0.5"
                  >
                    {(['list', 'grid'] as const).map((option) => {
                      const Icon = option === 'list' ? List : LayoutGrid;
                      return (
                        <button
                          key={option}
                          type="button"
                          aria-label={t(
                            option === 'list' ? 'listPage.listView' : 'listPage.gridView'
                          )}
                          aria-pressed={view === option}
                          onClick={() => setView(option)}
                          className={`flex min-h-9 min-w-9 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${view === option ? 'bg-primary/10 text-primary shadow-sm' : 'text-muted-foreground hover:bg-white'}`}
                        >
                          <Icon size={18} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </div>
                {renderGroups(groupedPendingItems, false)}
              </section>
            )}

            {purchasedItems.length > 0 && (
              <section className="mb-3 rounded-2xl bg-green-50/80 p-2 space-y-2">
                <h2>
                  <button
                    type="button"
                    aria-expanded={purchasedExpanded}
                    aria-controls="shopping-purchased"
                    title={t(purchasedExpanded ? 'listPage.collapseGroup' : 'listPage.expandGroup')}
                    onClick={() => toggleGroup(purchasedKey)}
                    className="flex w-full items-center justify-between min-h-9 gap-2 px-1 text-left text-lg font-semibold text-gray-900 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {t('listPage.purchased', { count: purchasedItems.length })}
                    <PurchasedChevron size={18} aria-hidden="true" />
                  </button>
                </h2>
                <div id="shopping-purchased" className="space-y-2">
                  {purchasedExpanded && renderGroups(groupedPurchasedItems, true)}
                </div>
              </section>
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
              <div className="flex gap-3">
                <Link
                  href={`/categories?listId=${listId}`}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-2 py-3 rounded-xl text-sm font-semibold text-center transition-colors"
                >
                  {t('listPage.addProducts')}
                </Link>
                {items.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="flex-1 bg-red-500 hover:bg-red-600 text-white px-2 py-3 rounded-xl text-sm font-semibold transition-colors"
                  >
                    {t('listPage.clearAll')}
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-center mt-3">
              <Link href="/history" className="text-sm text-blue-600 hover:text-blue-800 underline">
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
