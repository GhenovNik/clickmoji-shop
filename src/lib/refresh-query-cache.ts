import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

// The list key is the one a failed row cycle reloads (AGE-1649): an ordinary invalidation of it
// must join any held read instead of cancelling it, then trigger a fresh read once the held one
// settles so a confirmed write still reaches cache and UI. Every other key keeps the caller's choice.
const listTag = queryKeys.list('')[0];

function logRefreshError(error: unknown) {
  console.error('Error refreshing query cache:', error);
}

export function refreshQueryCache(
  client: QueryClient,
  keys: readonly QueryKey[],
  options?: { cancelRefetch?: boolean }
) {
  for (const queryKey of keys) {
    const isListKey = queryKey[0] === listTag;
    const refreshOptions = isListKey ? { ...options, cancelRefetch: false } : options;

    try {
      const inFlight = isListKey
        ? client
            .getQueryCache()
            .findAll({ queryKey, fetchStatus: 'fetching' })
            .map((query) => query.promise)
            .filter((promise): promise is Promise<unknown> => promise !== undefined)
        : [];
      const refresh = client.invalidateQueries({ queryKey }, refreshOptions);
      void refresh.catch(logRefreshError);
      if (inFlight.length > 0) {
        void Promise.allSettled([refresh, ...inFlight]).then(() => {
          try {
            void client.invalidateQueries({ queryKey }, refreshOptions).catch(logRefreshError);
          } catch (error) {
            logRefreshError(error);
          }
        });
      }
    } catch (error) {
      logRefreshError(error);
    }
  }
}
