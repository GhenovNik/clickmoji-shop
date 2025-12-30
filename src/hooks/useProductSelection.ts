'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useLists } from '@/store/lists';

export type Product = {
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

// API functions
const fetchProductsByCategoryAPI = async (categoryId: string): Promise<Product[]> => {
  const res = await fetch(`/api/products?categoryId=${categoryId}`);
  if (!res.ok) throw new Error('Failed to fetch products');
  return res.json();
};

const fetchFavoritesAPI = async () => {
  const res = await fetch('/api/favorites');
  if (!res.ok) throw new Error('Failed to fetch favorites');
  return res.json();
};

const addFavoriteAPI = async (productId: string) => {
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId }),
  });
  if (!res.ok) throw new Error('Failed to add favorite');
  return res.json();
};

const removeFavoriteAPI = async (productId: string) => {
  const res = await fetch(`/api/favorites?productId=${productId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to remove favorite');
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

export function useProductSelection(categoryId: string) {
  const router = useRouter();
  const { data: session } = useSession();
  const { lists, activeListId, setLists } = useLists();
  const queryClient = useQueryClient();

  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  // Load lists if needed (maintain existing pattern with useLists store)
  useEffect(() => {
    if (session?.user && lists.length === 0) {
      fetch('/api/lists')
        .then((res) => res.json())
        .then((data) => setLists(data))
        .catch((error) => console.error('Error loading lists:', error));
    }
  }, [session, lists.length, setLists]);

  // Query for products by category
  const { data: products = [], isLoading: loading } = useQuery({
    queryKey: ['products', categoryId],
    queryFn: () => fetchProductsByCategoryAPI(categoryId),
    enabled: !!categoryId,
  });

  // Query for favorites
  const { data: favoritesData = [] } = useQuery({
    queryKey: ['favorites'],
    queryFn: fetchFavoritesAPI,
    enabled: !!session?.user,
  });

  const favoriteProducts = new Set<string>(
    favoritesData.map((fav: { product: { id: string } }) => fav.product.id)
  );

  // Mutation for adding favorite
  const addFavoriteMutation = useMutation({
    mutationFn: addFavoriteAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });

  // Mutation for removing favorite
  const removeFavoriteMutation = useMutation({
    mutationFn: removeFavoriteAPI,
    onSuccess: () => {
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

  const toggleFavorite = async (productId: string) => {
    if (!session?.user) {
      alert('Войдите чтобы добавить товары в избранное');
      return;
    }

    const isFavorite = favoriteProducts.has(productId);

    try {
      if (isFavorite) {
        await removeFavoriteMutation.mutateAsync(productId);
      } else {
        await addFavoriteMutation.mutateAsync(productId);
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
    }
  };

  const addToList = async () => {
    if (!activeListId) {
      alert('Сначала выберите список');
      return;
    }

    setAdding(true);

    const selectedItems = products
      .filter((product) => selectedProducts.has(product.id))
      .map((product) => ({
        productId: product.id,
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
    products,
    selectedProducts,
    favoriteProducts,
    loading,
    adding,
    toggleProduct,
    toggleFavorite,
    addToList,
  };
}
