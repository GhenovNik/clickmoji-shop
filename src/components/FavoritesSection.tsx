'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { listsQueryKey, useActiveList } from '@/hooks/useListsQuery';
import { queryKeys } from '@/lib/query-keys';
import { refreshQueryCache } from '@/lib/refresh-query-cache';
import {
  favoriteDisplay,
  favoriteKey,
  favoriteListItem,
  favoriteRemoveUrl,
  favoriteTarget,
  type FavoriteVariant,
} from '@/lib/favorites';

type FavoriteProduct = {
  id: string;
  productId: string;
  usageCount: number;
  product: {
    id: string;
    name: string;
    nameEn?: string | null;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
    imageUrlEn?: string | null;
    category: {
      id: string;
      name: string;
      nameEn?: string | null;
      emoji: string;
      isCustom: boolean;
      imageUrl: string | null;
    };
  };
  variant?: FavoriteVariant | null;
};

type AddFeedback = {
  pending: boolean;
  addFailed: boolean;
  succeeded: boolean;
  // Deliberate duplicates stay possible without losing earlier failed usage updates.
  failedUsage: number;
};
const emptyFeedback: AddFeedback = {
  pending: false,
  addFailed: false,
  succeeded: false,
  failedUsage: 0,
};
const addTargetKey = (listId: string, favorite: FavoriteProduct) =>
  JSON.stringify([listId, favoriteKey(favorite)]);

const fetchFavoritesAPI = async (): Promise<FavoriteProduct[]> => {
  const res = await fetch('/api/favorites');
  if (!res.ok) throw new Error('Failed to fetch favorites');
  return res.json();
};

const updateFavoriteUsageAPI = async (favorite: FavoriteProduct) => {
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(favoriteTarget(favorite)),
  });
  if (!res.ok) throw new Error('Failed to update favorite usage');
  return res.json();
};

const removeFavoriteAPI = async (favorite: FavoriteProduct) => {
  const res = await fetch(favoriteRemoveUrl(favorite), { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to remove favorite');
  return res.json();
};

const addFavoriteToListAPI = async ({
  listId,
  item,
}: {
  listId: string;
  item: { productId: string; variantId: string | null };
}) => {
  const res = await fetch(`/api/lists/${listId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [item] }),
  });
  if (!res.ok) throw new Error('Failed to add favorite to list');
  return res.json();
};

export default function FavoritesSection() {
  const { data: session } = useSession();
  const { activeListId } = useActiveList();
  const queryClient = useQueryClient();
  const t = useTranslations('catalog');
  const locale = useLocale();
  const [addError, setAddError] = useState('');
  const [feedback, setFeedback] = useState<Record<string, AddFeedback>>({});
  const pendingTargets = useRef(new Set<string>());

  const { data: favorites = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: fetchFavoritesAPI,
    enabled: !!session?.user,
  });

  const removeMutation = useMutation({
    mutationFn: removeFavoriteAPI,
    onMutate: async (favorite) => {
      const key = favoriteKey(favorite);
      await queryClient.cancelQueries({ queryKey: queryKeys.favorites() });
      const previousFavorites = queryClient.getQueryData<FavoriteProduct[]>(queryKeys.favorites());

      queryClient.setQueryData<FavoriteProduct[]>(queryKeys.favorites(), (old) => {
        if (!old) return old;
        return old.filter((fav) => favoriteKey(fav) !== key);
      });

      return { previousFavorites };
    },
    onError: (err, favorite, context) => {
      if (context?.previousFavorites) {
        queryClient.setQueryData(queryKeys.favorites(), context.previousFavorites);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
    },
  });

  const handleAddToList = async (favorite: FavoriteProduct, usageOnly = false) => {
    setAddError('');
    if (!activeListId) {
      setAddError(t('shared.selectListFirst'));
      return;
    }

    const listId = activeListId;
    const key = addTargetKey(listId, favorite);
    // A pending render is not synchronous: guard two taps in the same event turn, too.
    if (pendingTargets.current.has(key) || (usageOnly && !feedback[key]?.failedUsage)) return;
    pendingTargets.current.add(key);
    const updateFeedback = (update: (previous: AddFeedback) => AddFeedback) =>
      setFeedback((current) => ({ ...current, [key]: update(current[key] ?? emptyFeedback) }));
    updateFeedback((previous) => ({
      ...previous,
      pending: true,
      addFailed: false,
      succeeded: false,
    }));

    try {
      if (!usageOnly) {
        try {
          await addFavoriteToListAPI({ listId, item: favoriteListItem(favorite) });
        } catch (error) {
          console.error('Error adding favorite to list:', error);
          updateFeedback((previous) => ({ ...previous, addFailed: true }));
          return;
        }
        refreshQueryCache(queryClient, [listsQueryKey, queryKeys.list(listId)]);
      }

      try {
        await updateFavoriteUsageAPI(favorite);
        updateFeedback((previous) => ({
          ...previous,
          succeeded: true,
          failedUsage: previous.failedUsage - (usageOnly ? 1 : 0),
        }));
        refreshQueryCache(queryClient, [queryKeys.favorites()]);
      } catch (error) {
        console.error('Error updating favorite usage after list add:', error);
        updateFeedback((previous) => ({
          ...previous,
          failedUsage: previous.failedUsage + (usageOnly ? 0 : 1),
        }));
      }
    } finally {
      pendingTargets.current.delete(key);
      updateFeedback((previous) => ({ ...previous, pending: false }));
    }
  };

  const handleRemoveFromFavorites = async (favorite: FavoriteProduct) => {
    try {
      await removeMutation.mutateAsync(favorite);
    } catch (error) {
      console.error('Error removing from favorites:', error);
    }
  };

  if (!session?.user) {
    return null;
  }

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-gray-500">{t('favoritesSection.loading')}</div>
      </div>
    );
  }

  if (favorites.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="text-4xl mb-2">⭐</div>
        <p className="text-gray-600">{t('favoritesSection.emptyTitle')}</p>
        <p className="text-sm text-gray-500 mt-1">{t('favoritesSection.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="mb-12">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-900">⭐ {t('favoritesSection.title')}</h2>
        <span className="text-sm text-gray-500">
          {t('shared.productCount', { count: favorites.length })}
        </span>
      </div>

      {addError && !activeListId && (
        <p role="alert" className="text-red-500 text-sm mb-2">
          {addError}
        </p>
      )}
      <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-3">
        {favorites.map((favorite) => {
          const { name, imageUrl, emoji } = favoriteDisplay(favorite, locale);
          const state = activeListId ? feedback[addTargetKey(activeListId, favorite)] : undefined;
          return (
            <div key={favorite.id} className="relative group">
              <button
                onClick={() => handleAddToList(favorite)}
                disabled={state?.pending}
                className="w-full bg-white rounded-xl p-3 shadow-md hover:shadow-lg hover:scale-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                title={name}
              >
                {imageUrl ? (
                  <Image
                    src={imageUrl}
                    alt={name}
                    width={64}
                    height={64}
                    className="w-12 h-12 sm:w-16 sm:h-16 object-contain mx-auto"
                  />
                ) : (
                  <div className="text-3xl sm:text-4xl">{emoji}</div>
                )}
              </button>

              {state?.addFailed && (
                <p role="alert" className="text-red-500 text-sm mt-2">
                  {t('shared.addProductFailed')}
                </p>
              )}
              {!!state?.failedUsage && (
                <div className="text-sm mt-2">
                  <p role="alert" className="text-amber-800">
                    {t('favoritesSection.usageUpdateFailed')}
                  </p>
                  <button
                    onClick={() => handleAddToList(favorite, true)}
                    disabled={state.pending}
                    className="text-blue-600 underline disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('favoritesSection.retryUsage')}
                  </button>
                </div>
              )}
              {state?.succeeded && !state.failedUsage && (
                <p role="status" className="text-green-700 text-sm mt-2">
                  {t('favoritesSection.added')}
                </p>
              )}

              {/* Reveal the remove action on hover. */}
              <button
                onClick={() => handleRemoveFromFavorites(favorite)}
                className="absolute -top-2 -right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                title={t('shared.removeFavorite')}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-gray-500 text-center mt-4">{t('favoritesSection.tapHint')}</p>
    </div>
  );
}
