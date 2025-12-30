'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useLists } from '@/store/lists';

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
    category: {
      id: string;
      name: string;
      emoji: string;
      isCustom: boolean;
      imageUrl: string | null;
    };
  };
};

// API functions
const fetchFavoritesAPI = async (): Promise<FavoriteProduct[]> => {
  const res = await fetch('/api/favorites');
  if (!res.ok) throw new Error('Failed to fetch favorites');
  return res.json();
};

const removeFromFavoritesAPI = async (productId: string) => {
  const res = await fetch(`/api/favorites?productId=${productId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to remove from favorites');
  return res.json();
};

const addToListAPI = async (listId: string, items: { productId: string }[]) => {
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
  const { lists, activeListId, setLists } = useLists();
  const queryClient = useQueryClient();

  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  // Load lists if needed (maintain existing pattern with useLists store)
  useEffect(() => {
    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (lists.length === 0) {
      fetch('/api/lists')
        .then((res) => res.json())
        .then((data) => setLists(data))
        .catch((error) => console.error('Error loading lists:', error));
    }
  }, [session, router, lists.length, setLists]);

  // Query for favorites with React Query
  const { data: favorites = [], isLoading: loading } = useQuery({
    queryKey: ['favorites'],
    queryFn: fetchFavoritesAPI,
    enabled: !!session?.user,
  });

  // Mutation for removing from favorites with optimistic updates
  const removeMutation = useMutation({
    mutationFn: removeFromFavoritesAPI,
    onMutate: async (productId) => {
      await queryClient.cancelQueries({ queryKey: ['favorites'] });
      const previousFavorites = queryClient.getQueryData<FavoriteProduct[]>(['favorites']);

      queryClient.setQueryData<FavoriteProduct[]>(['favorites'], (old) => {
        if (!old) return old;
        return old.filter((fav) => fav.product.id !== productId);
      });

      // Also remove from selection
      setSelectedProducts((prev) => {
        const newSet = new Set(prev);
        newSet.delete(productId);
        return newSet;
      });

      return { previousFavorites };
    },
    onError: (err, productId, context) => {
      if (context?.previousFavorites) {
        queryClient.setQueryData(['favorites'], context.previousFavorites);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });

  const toggleProduct = (productId: string) => {
    setSelectedProducts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(productId)) {
        newSet.delete(productId);
      } else {
        newSet.add(productId);
      }
      return newSet;
    });
  };

  const removeFromFavorites = async (productId: string) => {
    await removeMutation.mutateAsync(productId);
  };

  const addToList = async () => {
    if (!activeListId) {
      alert('Сначала выберите список');
      return;
    }

    setAdding(true);

    const selectedItems = favorites
      .filter((fav) => selectedProducts.has(fav.product.id))
      .map((fav) => ({
        productId: fav.product.id,
      }));

    try {
      const response = await addToListAPI(activeListId, selectedItems);

      const listsResponse = await fetch('/api/lists');
      if (listsResponse.ok) {
        const listsData = await listsResponse.json();
        setLists(listsData);
      }

      // Invalidate list cache to refresh items
      queryClient.invalidateQueries({ queryKey: ['list', activeListId] });

      // Show message about duplicates
      if (response.duplicates && response.duplicates.length > 0) {
        const duplicateNames = response.duplicates
          .map((d: { emoji: string; name: string }) => `${d.emoji} ${d.name}`)
          .join(', ');
        alert(`${response.message}\n\nУже в списке: ${duplicateNames}`);
      }

      if (activeListId) {
        router.push(`/lists/${activeListId}`);
      } else {
        router.push('/lists');
      }
    } catch (error) {
      console.error('Error adding items to list:', error);
      alert('Ошибка при добавлении товаров');
    } finally {
      setAdding(false);
    }
  };

  return {
    favorites,
    selectedProducts,
    loading,
    adding,
    toggleProduct,
    removeFromFavorites,
    addToList,
  };
}
