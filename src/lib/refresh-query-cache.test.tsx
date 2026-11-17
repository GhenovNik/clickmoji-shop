import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { refreshQueryCache } from './refresh-query-cache';

// AGE-1649 FR-3: an ordinary invalidation of the list key must join the held list read instead
// of cancelling it; every other key keeps the cancelling default.

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

// One controlled read per queryFn call; each release settles exactly that read.
function heldReads() {
  const releases: Array<(value: string) => void> = [];
  const queryFn = () =>
    new Promise<string>((resolve) => {
      releases.push(resolve);
    });
  return { releases, queryFn };
}

describe('refreshQueryCache list-key policy', () => {
  it('invalidates the list key without cancelling and other keys with the default', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    refreshQueryCache(client, [queryKeys.lists(), queryKeys.list('list-1'), queryKeys.favorites()]);

    const optionsFor = (key: readonly unknown[]) => {
      const call = invalidateSpy.mock.calls.find(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(key)
      );
      return call?.[1];
    };
    expect(optionsFor(queryKeys.list('list-1'))).toEqual({ cancelRefetch: false });
    expect(optionsFor(queryKeys.lists())).toBeUndefined();
    expect(optionsFor(queryKeys.favorites())).toBeUndefined();
  });

  it('joins a held list read instead of cancelling it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { releases, queryFn } = heldReads();
    const useList = () => useQuery({ queryKey: queryKeys.list('list-1'), queryFn, staleTime: 0 });
    const view = renderHook(useList, { wrapper: wrapper(client) });
    releases[0]('mount read');
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    const requiredRead = client.fetchQuery({
      queryKey: queryKeys.list('list-1'),
      queryFn,
      staleTime: 0,
    });
    const outcome = requiredRead.then(
      () => 'settled',
      () => 'cancelled'
    );
    await tick();
    expect(client.isFetching({ queryKey: queryKeys.list('list-1'), exact: true })).toBe(1);

    refreshQueryCache(client, [queryKeys.list('list-1')]);

    await tick();
    // No observer refetch was started over the held read.
    expect(releases).toHaveLength(2);
    expect(client.isFetching({ queryKey: queryKeys.list('list-1'), exact: true })).toBe(1);
    releases[1]('required read');
    expect(await outcome).toBe('settled');
  });

  it('still cancels a held read of another key', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { releases, queryFn } = heldReads();
    const useFav = () => useQuery({ queryKey: queryKeys.favorites(), queryFn, staleTime: 0 });
    const view = renderHook(useFav, { wrapper: wrapper(client) });
    releases[0]('mount read');
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    const heldRead = client.fetchQuery({
      queryKey: queryKeys.favorites(),
      queryFn,
      staleTime: 0,
    });
    await tick();

    refreshQueryCache(client, [queryKeys.favorites()]);

    await tick();
    // The held read is abandoned: a new fetch starts over it and the held promise piggybacks on it.
    expect(releases).toHaveLength(3);
    releases[2]('refetched');
    await expect(heldRead).resolves.toBe('refetched');
  });
});
