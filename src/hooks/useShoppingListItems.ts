'use client';

import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { queryKeys } from '@/lib/query-keys';
import { useCompleteList } from '@/hooks/useListMutations';
import { purchaseIntentStore } from '@/hooks/purchaseIntent';

export type Item = {
  id: string;
  isPurchased: boolean;
  note?: string | null;
  product: {
    id: string;
    name: string;
    nameEn?: string | null;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
    imageUrlEn?: string | null;
    category: {
      name: string;
      nameEn?: string | null;
      emoji: string;
      order: number;
    };
  };
  variant?: {
    id: string;
    name: string;
    nameEn: string;
    emoji: string;
  } | null;
};

export type ListData = {
  id: string;
  name: string;
  items: Item[];
};

const fetchListAPI = async (listId: string): Promise<ListData> => {
  const response = await fetch(`/api/lists/${listId}`);
  if (!response.ok) throw new Error('Failed to fetch list');
  return response.json();
};

const updateNoteAPI = async ({
  listId,
  itemId,
  note,
}: {
  listId: string;
  itemId: string;
  note: string;
}) => {
  const response = await fetch(`/api/lists/${listId}/items/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (!response.ok) throw new Error('Failed to update note');
  return response.json();
};

const removeItemAPI = async ({ listId, itemId }: { listId: string; itemId: string }) => {
  const response = await fetch(`/api/lists/${listId}/items/${itemId}`, {
    method: 'DELETE',
  });
  if (response.status === 404) {
    return { success: true };
  }
  if (!response.ok) throw new Error('Failed to remove item');
  return response.json();
};

const rollbackOwners = new WeakMap<QueryClient, Map<string, symbol>>();

function owners(client: QueryClient) {
  let result = rollbackOwners.get(client);
  if (!result) rollbackOwners.set(client, (result = new Map()));
  return result;
}

export function useShoppingListItems(listId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useTranslations('lists');
  const intentStore = purchaseIntentStore(queryClient);

  // Query for fetching list
  const {
    data: list = null,
    isLoading: loading,
    refetch: fetchListItems,
  } = useQuery({
    queryKey: queryKeys.list(listId),
    queryFn: async () => {
      const read = intentStore.beginRead(listId);
      return intentStore.tagRead(await fetchListAPI(listId), read);
    },
    structuralSharing: (old, data) =>
      intentStore.applyRead(old as ListData | undefined, data as ListData),
    enabled: !!listId,
  });

  const items = list?.items || [];
  const completeMutation = useCompleteList();

  const toggleMutation = useMutation({
    mutationFn: ({ dispatch }: { dispatch: () => Promise<Response> }) => dispatch(),
    networkMode: 'online',
    retry: false,
  });

  // Mutation for removing item with optimistic updates
  const removeMutation = useMutation({
    mutationFn: removeItemAPI,
    onMutate: async ({ itemId }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.list(listId) });
      const previousList = queryClient.getQueryData<ListData>(queryKeys.list(listId));
      const index = previousList?.items.findIndex((item) => item.id === itemId) ?? -1;
      const row = index >= 0 ? previousList?.items[index] : undefined;
      const key = JSON.stringify([listId, itemId, 'delete']);
      const owner = Symbol();
      owners(queryClient).set(key, owner);
      queryClient.setQueryData<ListData>(
        queryKeys.list(listId),
        (old) => old && { ...old, items: old.items.filter((item) => item.id !== itemId) }
      );
      return { row, index, key, owner };
    },
    onError: (_err, _variables, context) => {
      if (!context?.row || owners(queryClient).get(context.key) !== context.owner) return;
      queryClient.setQueryData<ListData>(queryKeys.list(listId), (old) => {
        if (!old || old.items.some((item) => item.id === context.row!.id)) return old;
        const items = [...old.items];
        items.splice(context.index, 0, intentStore.overlay(listId, context.row!));
        return { ...old, items };
      });
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context && owners(queryClient).get(context.key) === context.owner) {
        owners(queryClient).delete(context.key);
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.list(listId) });
    },
  });

  // Mutation for updating note with optimistic updates
  const updateNoteMutation = useMutation({
    mutationFn: updateNoteAPI,
    onMutate: async ({ itemId, note }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.list(listId) });
      const previous = queryClient
        .getQueryData<ListData>(queryKeys.list(listId))
        ?.items.find((item) => item.id === itemId);
      const key = JSON.stringify([listId, itemId, 'note']);
      const owner = Symbol();
      owners(queryClient).set(key, owner);
      queryClient.setQueryData<ListData>(
        queryKeys.list(listId),
        (old) =>
          old && {
            ...old,
            items: old.items.map((item) => (item.id === itemId ? { ...item, note } : item)),
          }
      );
      return { previous, key, owner };
    },
    onError: (_err, { itemId, note }, context) => {
      if (!context?.previous || owners(queryClient).get(context.key) !== context.owner) return;
      queryClient.setQueryData<ListData>(
        queryKeys.list(listId),
        (old) =>
          old && {
            ...old,
            items: old.items.map((item) =>
              item.id === itemId && item.note === note
                ? { ...item, note: context.previous!.note }
                : item
            ),
          }
      );
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context && owners(queryClient).get(context.key) === context.owner) {
        owners(queryClient).delete(context.key);
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.list(listId) });
    },
  });

  // Wrapper functions to maintain API compatibility
  const togglePurchased = (itemId: string) =>
    intentStore.toggle(listId, itemId, (dispatch) => toggleMutation.mutateAsync({ dispatch }));

  const removeItem = async (itemId: string) => {
    await removeMutation.mutateAsync({ listId, itemId });
  };

  const updateNote = async (itemId: string, note: string) => {
    await updateNoteMutation.mutateAsync({ listId, itemId, note });
  };

  const clearAll = async () => {
    if (!confirm(t('listItems.clearConfirm'))) return;
    for (const item of items) {
      await removeItem(item.id);
    }
  };

  const completeList = async () => {
    // A second tap while the first request runs would only get "List is empty" back.
    if (items.length === 0 || completeMutation.isPending) return;

    try {
      await completeMutation.mutateAsync(listId);
      router.push('/history');
    } catch (error) {
      console.error('Error completing list:', error);
      alert(t('listItems.completeFailed'));
    }
  };

  return {
    list,
    items,
    loading,
    togglePurchased,
    removeItem,
    updateNote,
    clearAll,
    completeList,
  };
}
