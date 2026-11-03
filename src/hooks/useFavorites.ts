'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { listsQueryKey, useActiveList } from './useListsQuery';
import { queryKeys } from '@/lib/query-keys';
import { refreshQueryCache } from '@/lib/refresh-query-cache';
import {
  favoriteKey,
  favoriteListItem,
  favoriteRemoveUrl,
  type FavoriteVariant,
} from '@/lib/favorites';

export type FavoriteProduct = {
  id: string;
  productId: string;
  product: {
    id: string;
    name: string;
    nameEn: string;
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

// API functions
const fetchFavoritesAPI = async (): Promise<FavoriteProduct[]> => {
  const res = await fetch('/api/favorites');
  if (!res.ok) throw new Error('Failed to fetch favorites');
  return res.json();
};

const removeFromFavoritesAPI = async (favorite: FavoriteProduct) => {
  const res = await fetch(favoriteRemoveUrl(favorite), { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to remove from favorites');
  return res.json();
};

const addToListAPI = async (
  listId: string,
  items: { productId: string; variantId: string | null }[]
) => {
  const res = await fetch(`/api/lists/${listId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error('Failed to add items to list');
  return res.json();
};

export function useFavorites() {
  const router = useRouter();
  const { data: session } = useSession();
  const { activeListId } = useActiveList();
  const queryClient = useQueryClient();
  const t = useTranslations('catalog.shared');

  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const addPending = useRef(false);

  useEffect(() => {
    if (!session?.user) {
      router.push('/login');
    }
  }, [session, router]);

  // Query for favorites with React Query
  const { data: favorites = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: fetchFavoritesAPI,
    enabled: !!session?.user,
  });

  // Mutation for removing from favorites with optimistic updates
  const removeMutation = useMutation({
    mutationFn: removeFromFavoritesAPI,
    onMutate: async (favorite) => {
      const key = favoriteKey(favorite);
      await queryClient.cancelQueries({ queryKey: queryKeys.favorites() });
      const previousFavorites = queryClient.getQueryData<FavoriteProduct[]>(queryKeys.favorites());

      queryClient.setQueryData<FavoriteProduct[]>(queryKeys.favorites(), (old) => {
        if (!old) return old;
        return old.filter((fav) => favoriteKey(fav) !== key);
      });

      // Also remove from selection
      setSelectedProducts((prev) => {
        const newSet = new Set(prev);
        newSet.delete(key);
        return newSet;
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

  // Selection is keyed by favoriteKey: a product and its starred variant are separate cards.
  const toggleProduct = (key: string) => {
    setSelectedProducts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  };

  const removeFromFavorites = async (favorite: FavoriteProduct) => {
    await removeMutation.mutateAsync(favorite);
  };

  const addToList = async () => {
    if (addPending.current) return;
    setAddError('');
    if (!activeListId) {
      setAddError(t('selectListFirst'));
      return;
    }

    addPending.current = true;
    setAdding(true);

    const selectedItems = favorites
      .filter((fav) => selectedProducts.has(favoriteKey(fav)))
      .map(favoriteListItem);

    try {
      // This endpoint commits the entire validated batch or none of it.
      await addToListAPI(activeListId, selectedItems);
    } catch (error) {
      console.error('Error adding items to list:', error);
      setAddError(t('addProductsFailed'));
      return;
    } finally {
      addPending.current = false;
      setAdding(false);
    }

    setSelectedProducts(new Set());
    refreshQueryCache(queryClient, [listsQueryKey, queryKeys.list(activeListId)]);
    router.push(`/lists/${activeListId}`);
  };

  return {
    favorites,
    selectedProducts,
    loading,
    adding,
    addError,
    toggleProduct,
    removeFromFavorites,
    addToList,
  };
}
