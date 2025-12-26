'use client';

import { useState, useEffect } from 'react';
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
    category: {
      id: string;
      name: string;
      emoji: string;
    };
  };
};

export function useFavorites() {
  const router = useRouter();
  const { data: session } = useSession();
  const { lists, activeListId, setLists } = useLists();

  const [favorites, setFavorites] = useState<FavoriteProduct[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!session?.user) {
      router.push('/auth/signin');
      return;
    }

    if (lists.length === 0) {
      fetch('/api/lists')
        .then((res) => res.json())
        .then((data) => setLists(data))
        .catch((error) => console.error('Error loading lists:', error));
    }

    fetch('/api/favorites')
      .then((res) => res.json())
      .then((data) => {
        setFavorites(data);
        setLoading(false);
      })
      .catch((error) => {
        console.error('Error loading favorites:', error);
        setLoading(false);
      });
  }, [session, router, lists.length, setLists]);

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
    try {
      await fetch(`/api/favorites?productId=${productId}`, {
        method: 'DELETE',
      });
      setFavorites((prev) => prev.filter((fav) => fav.product.id !== productId));
      setSelectedProducts((prev) => {
        const newSet = new Set(prev);
        newSet.delete(productId);
        return newSet;
      });
    } catch (error) {
      console.error('Error removing from favorites:', error);
    }
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
      await fetch(`/api/lists/${activeListId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selectedItems }),
      });

      const listsResponse = await fetch('/api/lists');
      if (listsResponse.ok) {
        const listsData = await listsResponse.json();
        setLists(listsData);
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
