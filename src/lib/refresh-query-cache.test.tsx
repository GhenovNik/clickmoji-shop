import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider, onlineManager, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { refreshQueryCache } from './refresh-query-cache';

// AGE-1649 FR-3: an ordinary invalidation of the list key must join the held list read instead
// of cancelling it; every other key keeps the cancelling default.

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  onlineManager.setOnline(true);
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

// One controlled read per queryFn call; each release settles exactly that read.
function heldReads() {
  const releases: Array<(value: string) => void> = [];
  const rejections: Array<(error: Error) => void> = [];
  const queryFn = () =>
    new Promise<string>((resolve, reject) => {
      releases.push(resolve);
      rejections.push(reject);
    });
  return { releases, rejections, queryFn };
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

  it('triggers only one GET in the normal case when no list read is in flight', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { releases, queryFn } = heldReads();
    const useList = () => useQuery({ queryKey: queryKeys.list('list-1'), queryFn, staleTime: 0 });
    const view = renderHook(useList, { wrapper: wrapper(client) });
    releases[0]('mount read');
    await waitFor(() => expect(view.result.current.data).toBe('mount read'));

    refreshQueryCache(client, [queryKeys.list('list-1')]);

    await waitFor(() => expect(releases).toHaveLength(2));
    releases[1]('fresh read');
    await waitFor(() => expect(client.getQueryData(queryKeys.list('list-1'))).toBe('fresh read'));
    await tick();
    expect(releases).toHaveLength(2);
  });

  it('joins a held list read instead of cancelling it, then starts a fresh read after it settles', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { releases, queryFn } = heldReads();
    const useList = () => useQuery({ queryKey: queryKeys.list('list-1'), queryFn, staleTime: 0 });
    const view = renderHook(useList, { wrapper: wrapper(client) });
    releases[0]('mount read');
    await waitFor(() => expect(view.result.current.data).toBe('mount read'));

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

    // After the held read settles, a fresh read runs and updates cache and observer.
    await waitFor(() => expect(releases).toHaveLength(3));
    releases[2]('fresh after write');
    await waitFor(() => {
      expect(client.getQueryData(queryKeys.list('list-1'))).toBe('fresh after write');
      expect(view.result.current.data).toBe('fresh after write');
    });
  });

  it('starts the follow-up list read even when the held read rejects', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { releases, rejections, queryFn } = heldReads();
    const useList = () => useQuery({ queryKey: queryKeys.list('list-1'), queryFn, staleTime: 0 });
    const view = renderHook(useList, { wrapper: wrapper(client) });
    releases[0]('mount read');
    await waitFor(() => expect(view.result.current.data).toBe('mount read'));

    const heldRead = client.fetchQuery({
      queryKey: queryKeys.list('list-1'),
      queryFn,
      staleTime: 0,
    });
    await tick();

    refreshQueryCache(client, [queryKeys.list('list-1')]);

    await tick();
    expect(releases).toHaveLength(2);
    rejections[1](new Error('network error'));
    await expect(heldRead).rejects.toThrow('network error');

    await waitFor(() => expect(releases).toHaveLength(3));
    releases[2]('recovered after write');
    await waitFor(() =>
      expect(client.getQueryData(queryKeys.list('list-1'))).toBe('recovered after write')
    );
  });

  it('logs and swallows synchronous query-cache lookup failures as best-effort housekeeping', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(client, 'getQueryCache').mockImplementation(() => {
      throw new Error('cache unavailable');
    });

    expect(() =>
      refreshQueryCache(client, [queryKeys.list('list-1'), queryKeys.lists()])
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('still cancels a held read of another key', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { releases, queryFn } = heldReads();
    const useFav = () => useQuery({ queryKey: queryKeys.favorites(), queryFn, staleTime: 0 });
    const view = renderHook(useFav, { wrapper: wrapper(client) });
    releases[0]('mount read');
    await waitFor(() => expect(view.result.current.data).toBe('mount read'));

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

  it('follows up a paused retryer cycle without cancelling it when retry is 1 and cache is populated', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0, staleTime: 5 * 60 * 1000 } },
    });
    const { releases, rejections, queryFn } = heldReads();
    const useList = () => useQuery({ queryKey: queryKeys.list('list-1'), queryFn });
    const view = renderHook(useList, { wrapper: wrapper(client) });
    releases[0]('initial [A]');
    await waitFor(() => expect(view.result.current.data).toBe('initial [A]'));

    void client.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    await waitFor(() => expect(releases).toHaveLength(2));

    onlineManager.setOnline(false);
    rejections[1](new Error('temp read failure'));
    await waitFor(() => {
      const query = client.getQueryCache().find({ queryKey: queryKeys.list('list-1') });
      expect(query?.state.fetchStatus).toBe('paused');
    });

    refreshQueryCache(client, [queryKeys.list('list-1')]);

    await tick();
    expect(releases).toHaveLength(2);
    expect(
      client.getQueryCache().find({ queryKey: queryKeys.list('list-1') })?.state.fetchStatus
    ).toBe('paused');

    onlineManager.setOnline(true);
    await waitFor(() => expect(releases).toHaveLength(3));
    rejections[2](new Error('retry also failed'));

    await waitFor(() => expect(releases).toHaveLength(4));
    releases[3]('fresh [A, B]');
    await waitFor(() => {
      expect(client.getQueryData(queryKeys.list('list-1'))).toBe('fresh [A, B]');
      expect(view.result.current.data).toBe('fresh [A, B]');
    });
  });
});
