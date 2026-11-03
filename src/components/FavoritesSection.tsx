'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { listsQueryKey, useActiveList } from '@/hooks/useListsQuery';
import { queryKeys } from '@/lib/query-keys';
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

  const { data: favorites = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: fetchFavoritesAPI,
    enabled: !!session?.user,
  });

  const updateUsageMutation = useMutation({
    mutationFn: updateFavoriteUsageAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
    },
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

  const addToListMutation = useMutation({
    mutationFn: addFavoriteToListAPI,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: listsQueryKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.list(variables.listId) });
    },
  });

  const handleAddToList = async (favorite: FavoriteProduct) => {
    setAddError('');
    if (!activeListId) {
      setAddError(t('shared.selectListFirst'));
      return;
    }

    try {
      await addToListMutation.mutateAsync({
        listId: activeListId,
        item: favoriteListItem(favorite),
      });
      await updateUsageMutation.mutateAsync(favorite);
    } catch (error) {
      console.error('Error adding favorite to list:', error);
      setAddError(t('shared.addProductFailed'));
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

      {addError && (
        <p role="alert" className="text-red-500 text-sm mb-2">
          {addError}
        </p>
      )}
      <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-3">
        {favorites.map((favorite) => {
          const { name, imageUrl, emoji } = favoriteDisplay(favorite, locale);
          return (
            <div key={favorite.id} className="relative group">
              <button
                onClick={() => handleAddToList(favorite)}
                className="w-full bg-white rounded-xl p-3 shadow-md hover:shadow-lg hover:scale-105 transition-all"
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
