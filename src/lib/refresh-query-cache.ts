import type { QueryClient, QueryKey } from '@tanstack/react-query';

// Cache refresh is housekeeping, not the business operation. A committed write must never
// become a retryable write failure because a refresh throws or rejects.
export function refreshQueryCache(
  client: QueryClient,
  keys: readonly QueryKey[],
  options?: { cancelRefetch?: boolean }
) {
  for (const queryKey of keys) {
    try {
      void client.invalidateQueries({ queryKey }, options).catch((error: unknown) => {
        console.error('Error refreshing query cache:', error);
      });
    } catch (error) {
      console.error('Error refreshing query cache:', error);
    }
  }
}
