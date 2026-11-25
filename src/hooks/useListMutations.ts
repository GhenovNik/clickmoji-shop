'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { LOCALIZED_API_ERROR_HEADER, LOCALIZED_API_ERROR_VALUE } from '@/lib/api-error-source';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Only an error the app marked as its own (see api-error-source) carries text in the request
// language; a gateway's JSON `error` is not shown.
function localizedApiErrorMessage(res: Response, body: unknown): string | null {
  if (res.headers.get(LOCALIZED_API_ERROR_HEADER) !== LOCALIZED_API_ERROR_VALUE) return null;
  if (!isRecord(body)) return null;
  const message = body.error;
  return typeof message === 'string' && message.trim() ? message : null;
}

function isImportResponse(body: unknown): body is { results: Record<string, unknown> } {
  if (!isRecord(body) || !isRecord(body.results)) return false;
  const results = body.results;
  return ['added', 'created', 'skipped', 'failed'].every((key) => Array.isArray(results[key]));
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

// Turns the route's report into the shapes the window renders. Every entry is checked before it
// is shown: a non-object entry is dropped from the lists of successes, but a failed entry is kept
// (with fallback text) so the failure count stays honest.
function normalizeImportResults(
  report: Record<string, unknown>,
  fallbacks: { failedReason: string }
): ImportResults {
  const entries = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
  const added = (value: unknown) =>
    entries(value).map((item) => ({
      name: textOf(item.name),
      category: textOf(item.category),
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
    }));
  return {
    added: added(report.added),
    created: added(report.created),
    skipped: entries(report.skipped).map((item) => ({
      name: textOf(item.name),
      reason: textOf(item.reason),
    })),
    failed: Array.isArray(report.failed)
      ? report.failed.map((item) => {
          const row = isRecord(item) ? item : {};
          const product = isRecord(row.product) ? row.product : {};
          return {
            product: { nameRu: textOf(product.nameRu), nameEn: textOf(product.nameEn) },
            reason: textOf(row.reason) || fallbacks.failedReason,
          };
        })
      : [],
  };
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
        throw new Error(localizedApiErrorMessage(res, data) ?? t('importMutation.failed'));
      }
      if (!isImportResponse(data)) {
        throw new Error(t('importMutation.failed'));
      }
      return {
        results: normalizeImportResults(data.results, {
          failedReason: t('importMutation.failed'),
        }),
      };
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
