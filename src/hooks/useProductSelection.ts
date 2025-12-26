'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useLists } from '@/store/lists';

export type Product = {
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

export function useProductSelection(categoryId: string) {
  const router = useRouter();
  const { data: session } = useSession();
  const { lists, activeListId, setLists } = useLists();

  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [favoriteProducts, setFavoriteProducts] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (session?.user && lists.length === 0) {
      fetch('/api/lists')
        .then((res) => res.json())
        .then((data) => setLists(data))
        .catch((error) => console.error('Error loading lists:', error));
    }
  }, [session, lists.length, setLists]);

  useEffect(() => {
    fetch(`/api/products?categoryId=${categoryId}`)
      .then((res) => res.json())
      .then((data) => {
        setProducts(data);
        setLoading(false);
      })
      .catch((error) => {
        console.error('Error loading products:', error);
        setLoading(false);
      });
  }, [categoryId]);

  useEffect(() => {
    if (session?.user) {
      fetch('/api/favorites')
        .then((res) => res.json())
        .then((favorites) => {
          const favoriteIds = new Set<string>(
            favorites.map((fav: { product: { id: string } }) => fav.product.id)
          );
          setFavoriteProducts(favoriteIds);
        })
        .catch((error) => {
          console.error('Error loading favorites:', error);
        });
    }
  }, [session]);

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
        await fetch(`/api/favorites?productId=${productId}`, {
          method: 'DELETE',
        });
        setFavoriteProducts((prev) => {
          const newSet = new Set(prev);
          newSet.delete(productId);
          return newSet;
        });
      } else {
        await fetch('/api/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId }),
        });
        setFavoriteProducts((prev) => new Set([...prev, productId]));
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
