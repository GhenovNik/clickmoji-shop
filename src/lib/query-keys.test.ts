import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { PurchaseIntentStore } from '@/hooks/purchaseIntent';
import { queryKeys } from './query-keys';

describe('list query prefix', () => {
  it('matches every list key without matching the lists collection', () => {
    const prefixFactory = Reflect.get(queryKeys, 'listPrefix') as
      (() => readonly unknown[]) | undefined;
    const prefix = prefixFactory?.();
    expect(prefix).toEqual(['list']);
    expect(queryKeys.list('a').slice(0, prefix?.length)).toEqual(prefix);
    expect(queryKeys.list('b').slice(0, prefix?.length)).toEqual(prefix);
    expect(queryKeys.lists().slice(0, prefix?.length)).not.toEqual(prefix);
  });

  it('clears every list on an identity change without clearing other queries', () => {
    const client = new QueryClient();
    const store = new PurchaseIntentStore(client);
    client.setQueryData(queryKeys.list('a'), 'a');
    client.setQueryData(queryKeys.list('b'), 'b');
    client.setQueryData(queryKeys.lists(), 'collection');
    client.setQueryData(queryKeys.favorites(), 'favorites');
    store.observeSession('authenticated', 'a');
    store.observeSession('authenticated', 'b');
    expect(client.getQueryData(queryKeys.list('a'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.list('b'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.lists())).toBe('collection');
    expect(client.getQueryData(queryKeys.favorites())).toBe('favorites');
  });
});
