'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useRestoreHistory } from '@/hooks/useListMutations';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';

type HistoryItem = {
  id: string;
  productId: string | null;
  variantId: string | null;
  productName: string;
  productNameEn?: string | null;
  productEmoji: string;
  productImageUrl: string | null;
  productImageUrlEn?: string | null;
  categoryName: string;
  categoryNameEn?: string | null;
  isCustom: boolean;
  variantName: string | null;
  variantNameEn?: string | null;
  variantEmoji: string | null;
  note: string | null;
  isPurchased: boolean;
  addedAt: string;
};

type HistoryList = {
  id: string;
  listName?: string | null;
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
  const { data: session, status } = useSession();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restoreMutation = useRestoreHistory();
  const t = useTranslations('history');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const locale = useLocale();

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
    }
  }, [status, router]);

  const { data: history = [], isLoading } = useQuery({
    queryKey: queryKeys.history(),
    queryFn: fetchHistory,
    enabled: !!session?.user,
  });

  const handleRestore = async (historyId: string) => {
    if (!session?.user) {
      alert(t('list.signInToRestore'));
      return;
    }

    const historyList = history.find((list) => list.id === historyId);
    if (!historyList) return;

    setRestoring(true);

    try {
      // Let the server use the snapshot's original name. Only legacy unnamed snapshots
      // need a localized fallback; never replace a saved name with the completion date.
      const { listId } = await restoreMutation.mutateAsync({
        historyId,
        ...(historyList.listName?.trim()
          ? {}
          : { name: t('list.restoredName', { date: formatDate(historyList.completedAt) }) }),
      });
      router.push(`/lists/${listId}`);
    } catch (error) {
      console.error('Error restoring list:', error);
      alert(t('list.restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  const handleDelete = async (historyId: string) => {
    if (!confirm(t('list.deleteConfirm'))) return;

    try {
      const res = await fetch(`/api/history/${historyId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete history');
      queryClient.invalidateQueries({ queryKey: queryKeys.history() });
    } catch (error) {
      console.error('Error deleting history:', error);
      alert(t('list.deleteFailed'));
    }
  };

  // History is fetched on the client, so dates keep the visitor's own time zone rather than the
  // UTC zone the provider uses for server-rendered text.
  const formatDate = (date: string) => {
    return format.dateTime(new Date(date), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
            <span>{t('page.backHome')}</span>
          </Link>
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">📜 {t('page.title')}</h1>
          <p className="text-gray-700">{t('page.subtitle')}</p>
        </div>

        {/* Empty State */}
        {isLoading ? (
          <div className="text-center text-gray-500">{tCommon('loading')}</div>
        ) : history.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 shadow-lg text-center">
            <div className="text-6xl mb-4">🛒</div>
            <p className="text-gray-700 text-lg mb-4">{t('empty.title')}</p>
            <p className="text-gray-600 mb-6">{t('empty.hint')}</p>
            <Link
              href="/lists"
              className="inline-block bg-blue-600 text-white px-6 py-3 rounded-xl hover:bg-blue-700 transition-colors"
            >
              {t('empty.toLists')}
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {history.map((list) => {
              const isExpanded = expandedId === list.id;
              const completedDate = formatDate(list.completedAt);
              const hasName = !!list.listName?.trim();
              return (
                <div key={list.id} className="bg-white rounded-2xl shadow-lg overflow-hidden">
                  {/* List Header - Clickable */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : list.id)}
                    className="w-full p-6 flex items-center justify-between gap-2 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <span className="text-2xl shrink-0">{isExpanded ? '📂' : '📁'}</span>
                      <div className="text-left min-w-0">
                        <h3 className="text-lg font-semibold text-gray-900 wrap-anywhere">
                          {hasName ? list.listName : completedDate}
                        </h3>
                        {hasName && (
                          <time dateTime={list.completedAt} className="block text-sm text-gray-600">
                            {completedDate}
                          </time>
                        )}
                        <p className="text-sm text-gray-600">
                          {t('list.itemCount', { count: list.items.length })}
                        </p>
                      </div>
                    </div>
                    <div className="text-gray-400 text-2xl shrink-0">{isExpanded ? '▼' : '▶'}</div>
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
                          {restoring ? t('list.restoring') : t('list.restore')}
                        </button>
                        <button
                          onClick={() => handleDelete(list.id)}
                          className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors font-semibold"
                        >
                          {tCommon('delete')}
                        </button>
                      </div>

                      {/* Items List */}
                      <div className="space-y-2">
                        {list.items.map((item) => {
                          const productName = localizedName(
                            { name: item.productName, nameEn: item.productNameEn },
                            locale
                          );
                          const imageUrl = productImageUrl(
                            { imageUrl: item.productImageUrl, imageUrlEn: item.productImageUrlEn },
                            locale
                          );
                          return (
                            <div
                              key={item.id}
                              className="flex items-center gap-3 p-3 rounded-lg bg-gray-50"
                            >
                              {item.isCustom && imageUrl ? (
                                <Image
                                  src={imageUrl}
                                  alt={productName}
                                  width={32}
                                  height={32}
                                  className="w-8 h-8 object-contain"
                                />
                              ) : (
                                <span className="text-2xl">{item.productEmoji}</span>
                              )}
                              <div className="flex-1">
                                <p className="font-medium text-gray-900">
                                  {productName}
                                  {item.variantName && (
                                    <span className="text-sm text-gray-600">
                                      {' '}
                                      -{' '}
                                      {localizedName(
                                        { name: item.variantName, nameEn: item.variantNameEn },
                                        locale
                                      )}
                                    </span>
                                  )}
                                </p>
                                <p className="text-sm text-gray-600">
                                  {localizedName(
                                    { name: item.categoryName, nameEn: item.categoryNameEn },
                                    locale
                                  )}
                                </p>
                                {item.note && <p className="text-xs text-gray-500">{item.note}</p>}
                              </div>
                              {item.isPurchased && (
                                <span className="text-green-600 font-semibold">✓</span>
                              )}
                            </div>
                          );
                        })}
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
