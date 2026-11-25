'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { changedBy } from '@/lib/query-keys';
import { refreshQueryCache } from '@/lib/refresh-query-cache';

// Mutations that change more than one cached entity. Each invalidates the keys listed for it in
// `changedBy`, so the screens that read those entities refetch instead of showing stale data for
// the five-minute staleTime.

export type ImportResults = {
  added: Array<{ name: string; category: string; note?: string }>;
  created: Array<{ name: string; category: string; note?: string }>;
  skipped: Array<{ name: string; reason: string }>;
  // Strings-only DTO from the route (fallback names for unusable AI entries).
  failed: Array<{ product?: { nameRu?: string; nameEn?: string }; reason: string }>;
};

function invalidate(queryClient: QueryClient, keys: ReadonlyArray<readonly unknown[]>) {
  // Not awaited: navigation after a mutation should not wait for refetches.
  for (const queryKey of keys) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

function apiErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('error' in body)) return null;
  const message = (body as { error: unknown }).error;
  return typeof message === 'string' && message.trim() ? message : null;
}

function isImportResponse(body: unknown): body is { results: ImportResults } {
  if (!body || typeof body !== 'object' || !('results' in body)) return false;
  const results = (body as { results: unknown }).results;
  if (!results || typeof results !== 'object') return false;
  const fields = results as Record<string, unknown>;
  return ['added', 'created', 'skipped', 'failed'].every((key) => Array.isArray(fields[key]));
}

export function useImportListText() {
  const queryClient = useQueryClient();
  const t = useTranslations('lists');

  return useMutation({
    mutationFn: async ({ listId, text }: { listId: string; text: string }) => {
      let res: Response;
      try {
        res = await fetch('/api/lists/import-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, listId }),
        });
      } catch {
        // No response at all (offline, dropped connection): never show the browser's own text.
        throw new Error(t('importMutation.network'));
      }
      // A body that is not JSON (a gateway page, an empty body) is treated as an unknown body.
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        // The API's own error text is already in the request language; anything else is generic.
        throw new Error(apiErrorMessage(data) ?? t('importMutation.failed'));
      }
      if (!isImportResponse(data)) {
        throw new Error(t('importMutation.failed'));
      }
      return data;
    },
    onSuccess: (data, { listId }) => {
      // Preserve the import endpoint's real added/created/failed report even if refetch fails.
      // The list-key policy of refreshQueryCache keeps a running required reload alive (AGE-1649).
      const keys = changedBy.importText(listId, data.results.created.length > 0);
      refreshQueryCache(queryClient, keys);
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
    mutationFn: async ({ historyId, name }: { historyId: string; name?: string }) => {
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
