'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { changedBy } from '@/lib/query-keys';

// Mutations that change more than one cached entity. Each invalidates the keys listed for it in
// `changedBy`, so the screens that read those entities refetch instead of showing stale data for
// the five-minute staleTime.

export type ImportResults = {
  added: Array<{ name: string; category: string; note?: string }>;
  created: Array<{ name: string; category: string; note?: string }>;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ product?: { nameRu?: string }; reason: string }>;
};

function invalidate(queryClient: QueryClient, keys: ReadonlyArray<readonly unknown[]>) {
  // Not awaited: navigation after a mutation should not wait for refetches.
  for (const queryKey of keys) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

export function useImportListText() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ listId, text }: { listId: string; text: string }) => {
      const res = await fetch('/api/lists/import-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, listId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Ошибка при импорте списка');
      }
      return data as { results: ImportResults };
    },
    onSuccess: (data, { listId }) => {
      invalidate(queryClient, changedBy.importText(listId, data.results.created.length > 0));
    },
  });
}

export function useCompleteList() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (listId: string) => {
      const response = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listId }),
      });
      if (!response.ok) {
        throw new Error('Failed to complete list');
      }
      return response.json();
    },
    onSuccess: (_history, listId) => {
      invalidate(queryClient, changedBy.completeList(listId));
    },
  });
}

export function useRestoreHistory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ historyId, name }: { historyId: string; name: string }) => {
      const response = await fetch(`/api/history/${historyId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        throw new Error('Failed to restore history');
      }
      return (await response.json()) as {
        listId: string;
        createdCount: number;
        skippedCount: number;
      };
    },
    onSuccess: () => {
      invalidate(queryClient, changedBy.restoreHistory());
    },
  });
}
