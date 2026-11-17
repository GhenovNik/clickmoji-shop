'use client';

import { useRef, useState } from 'react';
import { notifyManager, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { queryKeys } from '@/lib/query-keys';
import { useCompleteList } from '@/hooks/useListMutations';

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

// Typed PUT delivery outcome: status === null means the fetch rejected before
// a response arrived (transport); a number is the HTTP status received.
class TogglePurchasedError extends Error {
  readonly status: number | null;

  constructor(status: number | null, options?: { cause?: unknown }) {
    super(
      status === null ? 'Network request failed' : `Request failed with status ${status}`,
      options
    );
    this.name = 'TogglePurchasedError';
    this.status = status;
  }
}

const isRetryablePutStatus = (status: number) =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);

const isTogglePurchasedError = (error: unknown): error is TogglePurchasedError =>
  error instanceof TogglePurchasedError;

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
  let response: Response;
  try {
    response = await fetch(`/api/lists/${listId}/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPurchased }),
    });
  } catch (error) {
    throw new TogglePurchasedError(null, { cause: error });
  }
  // Any 2xx acknowledges delivery; the body is not required to parse.
  if (response.status >= 200 && response.status < 300) {
    return { success: true };
  }
  throw new TogglePurchasedError(response.status);
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

// 404 means the row is already gone on the server; any 2xx is an ACK without a body, so a
// committed delete is never reported as a failure because its body did not parse.
const removeItemAPI = async ({ listId, itemId }: { listId: string; itemId: string }) => {
  const response = await fetch(`/api/lists/${listId}/items/${itemId}`, {
    method: 'DELETE',
  });
  if (response.status === 404) {
    return { success: true };
  }
  if (!response.ok) throw new Error('Failed to remove item');
  return { success: true };
};

export function useShoppingListItems(listId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useTranslations('lists');
  const queryKey = queryKeys.list(listId);

  // Query for fetching list
  const {
    data: list = null,
    isLoading: loading,
    refetch: fetchListItems,
  } = useQuery({
    queryKey,
    queryFn: () => fetchListAPI(listId),
    enabled: !!listId,
  });

  const items = list?.items || [];
  const completeMutation = useCompleteList();

  // Row locks. The ref is what the guards read, synchronously and before any await; the state
  // only re-renders the busy controls. A locked row accepts no second request until its cycle
  // (writes, retries and the server read that follows) has settled.
  const lockedRef = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  // Busy state is published through the query client's scheduler, the same path its own cache
  // notifications take, so a lock taken outside a render commit does not update React directly.
  const publishBusy = () => {
    notifyManager.schedule(() => setBusyIds(new Set(lockedRef.current)));
  };

  const lockRows = (itemIds: readonly string[]): boolean => {
    if (itemIds.length === 0 || itemIds.some((itemId) => lockedRef.current.has(itemId))) {
      return false;
    }
    for (const itemId of itemIds) lockedRef.current.add(itemId);
    publishBusy();
    return true;
  };

  const unlockRows = (itemIds: readonly string[]) => {
    for (const itemId of itemIds) lockedRef.current.delete(itemId);
    publishBusy();
  };

  // Required server read after a failed cycle. A read already running is joined and waited for
  // (never cancelled), then one fresh read starts. The cache keeps its current value on failure.
  const readListRequired = async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    const read = () =>
      queryClient.fetchQuery({
        queryKey,
        queryFn: () => fetchListAPI(listId),
        staleTime: 0,
      });
    if (queryClient.isFetching({ queryKey, exact: true }) > 0) {
      await read().catch(() => undefined);
    }
    try {
      await read();
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };

  // Ordinary refresh after a committed write. It never cancels a running read, but a read that
  // is already running may predate this write, so it settles first and the refresh reads again.
  const refreshAfterWrite = async () => {
    if (queryClient.isFetching({ queryKey, exact: true }) > 0) {
      await queryClient
        .fetchQuery({ queryKey, queryFn: () => fetchListAPI(listId), staleTime: 0 })
        .catch(() => undefined);
    }
    await queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  };

  // One message and one log per failed cycle; the message names what the user now sees.
  const reportFailedCycle = async (cause: unknown) => {
    const reload = await readListRequired();
    console.error('List item action failed:', {
      cause,
      reloadError: reload.ok ? null : reload.error,
    });
    alert(t(reload.ok ? 'listItems.rowFailed' : 'listItems.reloadFailed'));
  };

  const runRowAction = async (itemIds: string[], action: () => Promise<void>) => {
    if (!lockRows(itemIds)) return;
    try {
      await action();
    } catch (error) {
      await reportFailedCycle(error);
    } finally {
      unlockRows(itemIds);
    }
  };

  // Mutation for toggling purchased status with optimistic updates. No snapshot is kept:
  // a failed cycle is replaced by the server read, never rolled back.
  const toggleMutation = useMutation({
    mutationFn: togglePurchasedAPI,
    retry: (failureCount, error) =>
      failureCount < 3 &&
      isTogglePurchasedError(error) &&
      (error.status === null || isRetryablePutStatus(error.status)),
    retryDelay: (failureCount) => [1000, 2000, 4000][Math.min(failureCount, 2)],
    onMutate: ({ itemId, isPurchased }) => {
      queryClient.setQueryData<ListData>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((i) => (i.id === itemId ? { ...i, isPurchased } : i)),
        };
      });
    },
  });

  // Wrapper functions to maintain API compatibility. They settle after the row's cycle and
  // never reject: a failed cycle is reported here, once.
  const togglePurchased = async (itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    await runRowAction([itemId], async () => {
      await toggleMutation.mutateAsync({
        listId,
        itemId,
        isPurchased: !item.isPurchased,
      });
      await refreshAfterWrite();
    });
  };

  const removeItem = async (itemId: string) => {
    await runRowAction([itemId], async () => {
      await removeItemAPI({ listId, itemId });
      await refreshAfterWrite();
    });
  };

  const updateNote = async (itemId: string, note: string) => {
    await runRowAction([itemId], async () => {
      await updateNoteAPI({ listId, itemId, note });
      await refreshAfterWrite();
    });
  };

  const clearAll = async () => {
    const itemIds = items.map((item) => item.id);
    if (!lockRows(itemIds)) return;
    try {
      if (!confirm(t('listItems.clearConfirm'))) return;
      try {
        // Sequential on purpose: the first failure stops the batch, so later rows are not sent.
        for (const itemId of itemIds) {
          await removeItemAPI({ listId, itemId });
        }
      } catch (error) {
        await reportFailedCycle(error);
        return;
      }
      await refreshAfterWrite();
    } finally {
      unlockRows(itemIds);
    }
  };

  const completeList = async () => {
    // Every row is locked while the request runs: no row write can overlap the completion.
    const itemIds = items.map((item) => item.id);
    if (!lockRows(itemIds)) return;

    try {
      await completeMutation.mutateAsync(listId);
      router.push('/history');
    } catch (error) {
      console.error('Error completing list:', error);
      alert(t('listItems.completeFailed'));
    } finally {
      unlockRows(itemIds);
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
    isItemBusy: (itemId: string) => busyIds.has(itemId),
    isListBusy: busyIds.size > 0,
  };
}
