import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

// The list key is the one a failed row cycle reloads (AGE-1649): an ordinary invalidation of it
// must join that held read instead of cancelling it. Every other key keeps the caller's choice.
const listTag = queryKeys.list('')[0];

export function refreshQueryCache(
  client: QueryClient,
  keys: readonly QueryKey[],
  options?: { cancelRefetch?: boolean }
) {
  for (const queryKey of keys) {
    const refreshOptions = queryKey[0] === listTag ? { ...options, cancelRefetch: false } : options;
    try {
      void client.invalidateQueries({ queryKey }, refreshOptions).catch((error: unknown) => {
        console.error('Error refreshing query cache:', error);
      });
    } catch (error) {
      console.error('Error refreshing query cache:', error);
    }
  }
}
