'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export type Item = {
  id: string;
  isPurchased: boolean;
  product: {
    id: string;
    name: string;
    emoji: string;
    category: {
      name: string;
    };
  };
};

export type ListData = {
  id: string;
  name: string;
  items: Item[];
};

export function useShoppingListItems(listId: string) {
  const router = useRouter();
  const [list, setList] = useState<ListData | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchListItems = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/lists/${listId}`);
      if (response.ok) {
        const data = await response.json();
        setList(data);
        setItems(data.items || []);
      }
    } catch (error) {
      console.error('Error fetching list items:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (listId) {
      fetchListItems();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId]);

  const togglePurchased = async (itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, isPurchased: !i.isPurchased } : i))
    );

    try {
      await fetch(`/api/lists/${listId}/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPurchased: !item.isPurchased }),
      });
    } catch (error) {
      console.error('Error toggling item:', error);
      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, isPurchased: item.isPurchased } : i))
      );
    }
  };

  const removeItem = async (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));

    try {
      await fetch(`/api/lists/${listId}/items/${itemId}`, {
        method: 'DELETE',
      });
      fetchListItems();
    } catch (error) {
      console.error('Error removing item:', error);
      fetchListItems();
    }
  };

  const clearAll = async () => {
    if (!confirm('Удалить все товары из списка?')) return;
    for (const item of items) {
      await removeItem(item.id);
    }
  };

  const completeList = async () => {
    if (items.length === 0) return;

    const historyItems = items.map((item) => ({
      id: item.id,
      productId: item.product.id,
      name: item.product.name,
      emoji: item.product.emoji,
      categoryName: item.product.category.name,
      isPurchased: item.isPurchased,
      addedAt: new Date(),
    }));

    const completedList = {
      id: `list-${Date.now()}`,
      completedAt: new Date(),
      items: historyItems,
    };

    // Удаляем все товары из текущего списка
    for (const item of items) {
      try {
        await fetch(`/api/lists/${listId}/items/${item.id}`, {
          method: 'DELETE',
        });
      } catch (error) {
        console.error('Error removing item:', error);
      }
    }

    // Сохраняем в localStorage
    const stored = localStorage.getItem('shopping-list-storage');
    if (stored) {
      const data = JSON.parse(stored);
      data.state.history = [completedList, ...(data.state.history || [])].slice(0, 20);
      localStorage.setItem('shopping-list-storage', JSON.stringify(data));
    }

    router.push('/history');
  };

  return {
    list,
    items,
    loading,
    togglePurchased,
    removeItem,
    clearAll,
    completeList,
  };
}
