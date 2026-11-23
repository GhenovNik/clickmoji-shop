'use client';

import { useCallback, useSyncExternalStore } from 'react';
import {
  notifyManager,
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { queryKeys } from '@/lib/query-keys';
import { getInFlightListPromises } from '@/lib/refresh-query-cache';
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

type ListLockSnapshot = {
  busyIds: ReadonlySet<string>;
  isCompleting: boolean;
};

type ListLockState = {
  lockedIds: Set<string>;
  completing: boolean;
  snapshot: ListLockSnapshot;
  listeners: Set<() => void>;
};

const EMPTY_LOCK_SNAPSHOT: ListLockSnapshot = {
  busyIds: new Set(),
  isCompleting: false,
};

// In-app navigation shares the root QueryClient, so row and Complete locks live per
// (QueryClient, listId) rather than per hook mount.
const listLocksByClient = new WeakMap<QueryClient, Map<string, ListLockState>>();

function getListLockState(queryClient: QueryClient, listId: string): ListLockState {
  let byList = listLocksByClient.get(queryClient);
  if (!byList) {
    byList = new Map();
    listLocksByClient.set(queryClient, byList);
  }
  let state = byList.get(listId);
  if (!state) {
    state = {
      lockedIds: new Set(),
      completing: false,
      snapshot: EMPTY_LOCK_SNAPSHOT,
      listeners: new Set(),
    };
    byList.set(listId, state);
  }
  return state;
}

// Busy state is published through the query client's scheduler, the same path its own cache
// notifications take, so a lock taken outside a render commit does not update React directly.
function publishListLock(state: ListLockState) {
  state.snapshot = {
    busyIds: new Set(state.lockedIds),
    isCompleting: state.completing,
  };
  notifyManager.schedule(() => {
    for (const listener of state.listeners) {
      listener();
    }
  });
}

function lockRows(state: ListLockState, itemIds: readonly string[]): boolean {
  if (
    state.completing ||
    itemIds.length === 0 ||
    itemIds.some((itemId) => state.lockedIds.has(itemId))
  ) {
    return false;
  }
  for (const itemId of itemIds) state.lockedIds.add(itemId);
  publishListLock(state);
  return true;
}

function unlockRows(state: ListLockState, itemIds: readonly string[]) {
  for (const itemId of itemIds) state.lockedIds.delete(itemId);
  publishListLock(state);
}

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

  const lockState = getListLockState(queryClient, listId);
  const subscribeLock = useCallback(
    (listener: () => void) => {
      lockState.listeners.add(listener);
      return () => {
        lockState.listeners.delete(listener);
      };
    },
    [lockState]
  );
  const getLockSnapshot = useCallback(() => lockState.snapshot, [lockState]);
  const { busyIds, isCompleting } = useSyncExternalStore(
    subscribeLock,
    getLockSnapshot,
    () => EMPTY_LOCK_SNAPSHOT
  );

  const updateCachedItems = (updater: (prev: Item[]) => Item[]) => {
    queryClient.setQueryData<ListData>(queryKey, (old) =>
      old ? { ...old, items: updater(old.items) } : old
    );
  };

  const waitForInFlightListReads = async () => {
    const inFlight = getInFlightListPromises(queryClient, queryKey, true);
    if (inFlight.length === 0) return false;
    await Promise.allSettled(inFlight);
    return true;
  };

  // Required server read after a failed cycle. Any live read (fetching or paused) settles first
  // without cancellation, then one fresh read starts. Confirmed ACK patches are re-applied if an
  // older in-flight read settled before the fresh read failed.
  const readListRequired = async (
    applyConfirmed?: () => void
  ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    if (await waitForInFlightListReads()) {
      applyConfirmed?.();
    }
    try {
      await queryClient.fetchQuery({
        queryKey,
        queryFn: () => fetchListAPI(listId),
        staleTime: 0,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };

  // Ordinary refresh after a committed write. Never cancels a running read; any read already live
  // (fetching or paused) settles first, confirmed ACK changes are preserved, and a fresh read runs.
  const refreshAfterWrite = async (applyConfirmed?: () => void) => {
    if (await waitForInFlightListReads()) {
      applyConfirmed?.();
    }
    await queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  };

  // One message and one log per failed cycle; the message names what the user now sees.
  const reportFailedCycle = async (cause: unknown, applyConfirmed?: () => void) => {
    const reload = await readListRequired(applyConfirmed);
    console.error('List item action failed:', {
      cause,
      reloadError: reload.ok ? null : reload.error,
    });
    alert(t(reload.ok ? 'listItems.rowFailed' : 'listItems.reloadFailed'));
  };

  const runRowAction = async (itemIds: string[], action: () => Promise<void>) => {
    const lock = lockState;
    if (!lockRows(lock, itemIds)) return;
    try {
      await action();
    } catch (error) {
      await reportFailedCycle(error);
    } finally {
      unlockRows(lock, itemIds);
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
      updateCachedItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, isPurchased } : i)));
    },
  });

  // Wrapper functions to maintain API compatibility. They settle after the row's cycle and
  // never reject: a failed cycle is reported here, once.
  const togglePurchased = async (itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const nextPurchased = !item.isPurchased;

    await runRowAction([itemId], async () => {
      await toggleMutation.mutateAsync({
        listId,
        itemId,
        isPurchased: nextPurchased,
      });
      await refreshAfterWrite(() =>
        updateCachedItems((prev) =>
          prev.map((i) => (i.id === itemId ? { ...i, isPurchased: nextPurchased } : i))
        )
      );
    });
  };

  const removeItem = async (itemId: string) => {
    const applyRemoval = () => updateCachedItems((prev) => prev.filter((i) => i.id !== itemId));
    await runRowAction([itemId], async () => {
      await removeItemAPI({ listId, itemId });
      applyRemoval();
      await refreshAfterWrite(applyRemoval);
    });
  };

  const updateNote = async (itemId: string, note: string) => {
    const applyNote = () =>
      updateCachedItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, note } : i)));
    await runRowAction([itemId], async () => {
      await updateNoteAPI({ listId, itemId, note });
      applyNote();
      await refreshAfterWrite(applyNote);
    });
  };

  const clearAll = async () => {
    const itemIds = items.map((item) => item.id);
    const lock = lockState;
    if (!lockRows(lock, itemIds)) return;
    const confirmedRemoved = new Set<string>();
    const applyConfirmedRemovals = () => {
      if (confirmedRemoved.size === 0) return;
      updateCachedItems((prev) => prev.filter((i) => !confirmedRemoved.has(i.id)));
    };
    try {
      if (!confirm(t('listItems.clearConfirm'))) return;
      try {
        // Sequential on purpose: the first failure stops the batch, so later rows are not sent.
        for (const itemId of itemIds) {
          await removeItemAPI({ listId, itemId });
          confirmedRemoved.add(itemId);
          applyConfirmedRemovals();
        }
      } catch (error) {
        await reportFailedCycle(error, applyConfirmedRemovals);
        return;
      }
      await refreshAfterWrite(applyConfirmedRemovals);
    } finally {
      unlockRows(lock, itemIds);
    }
  };

  const completeList = async () => {
    // Whole-cycle guard: keeps the empty-list guard, blocks row/batch/repeat Complete (including
    // rows arriving mid-flight) and refuses to start while any row or batch lock is held.
    const lock = lockState;
    if (items.length === 0 || lock.completing || lock.lockedIds.size > 0) return;
    lock.completing = true;
    publishListLock(lock);

    try {
      await completeMutation.mutateAsync(listId);
      router.push('/history');
    } catch (error) {
      console.error('Error completing list:', error);
      alert(t('listItems.completeFailed'));
    } finally {
      lock.completing = false;
      publishListLock(lock);
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
    isItemBusy: (itemId: string) => isCompleting || busyIds.has(itemId),
    isListBusy: isCompleting || busyIds.size > 0,
  };
}
