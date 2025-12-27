'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

// API functions
const fetchListAPI = async (listId: string): Promise<ListData> => {
  const response = await fetch(`/api/lists/${listId}`);
  if (!response.ok) throw new Error('Failed to fetch list');
  return response.json();
};

const togglePurchasedAPI = async ({
  listId,
  itemId,
  isPurchased,
}: {
  listId: string;
  itemId: string;
  isPurchased: boolean;
}) => {
  const response = await fetch(`/api/lists/${listId}/items/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPurchased }),
  });
  if (!response.ok) throw new Error('Failed to toggle item');
  return response.json();
};

const removeItemAPI = async ({ listId, itemId }: { listId: string; itemId: string }) => {
  const response = await fetch(`/api/lists/${listId}/items/${itemId}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to remove item');
  return response.json();
};

export function useShoppingListItems(listId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();

  // Query for fetching list
  const {
    data: list = null,
    isLoading: loading,
    refetch: fetchListItems,
  } = useQuery({
    queryKey: ['list', listId],
    queryFn: () => fetchListAPI(listId),
    enabled: !!listId,
  });

  const items = list?.items || [];

  // Mutation for toggling purchased status with optimistic updates
  const toggleMutation = useMutation({
    mutationFn: togglePurchasedAPI,
    onMutate: async ({ itemId, isPurchased }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['list', listId] });

      // Snapshot previous value
      const previousList = queryClient.getQueryData<ListData>(['list', listId]);

      // Optimistically update
      queryClient.setQueryData<ListData>(['list', listId], (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((i) => (i.id === itemId ? { ...i, isPurchased } : i)),
        };
      });

      return { previousList };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousList) {
        queryClient.setQueryData(['list', listId], context.previousList);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['list', listId] });
    },
  });

  // Mutation for removing item with optimistic updates
  const removeMutation = useMutation({
    mutationFn: removeItemAPI,
    onMutate: async ({ itemId }) => {
      await queryClient.cancelQueries({ queryKey: ['list', listId] });
      const previousList = queryClient.getQueryData<ListData>(['list', listId]);

      queryClient.setQueryData<ListData>(['list', listId], (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.filter((i) => i.id !== itemId),
        };
      });

      return { previousList };
    },
    onError: (err, variables, context) => {
      if (context?.previousList) {
        queryClient.setQueryData(['list', listId], context.previousList);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['list', listId] });
    },
  });

  // Wrapper functions to maintain API compatibility
  const togglePurchased = async (itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    await toggleMutation.mutateAsync({
      listId,
      itemId,
      isPurchased: !item.isPurchased,
    });
  };

  const removeItem = async (itemId: string) => {
    await removeMutation.mutateAsync({ listId, itemId });
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

    // Remove all items from current list
    for (const item of items) {
      try {
        await fetch(`/api/lists/${listId}/items/${item.id}`, {
          method: 'DELETE',
        });
      } catch (error) {
        console.error('Error removing item:', error);
      }
    }

    // Save to localStorage
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
