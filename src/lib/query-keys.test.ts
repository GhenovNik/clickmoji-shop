import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys';

describe('list query prefix', () => {
  it('matches every list key without matching the lists collection', () => {
    const prefixFactory = Reflect.get(queryKeys, 'listPrefix') as (() => readonly unknown[]) | undefined;
    const prefix = prefixFactory?.();
    expect(prefix).toEqual(['list']);
    expect(queryKeys.list('a').slice(0, prefix?.length)).toEqual(prefix);
    expect(queryKeys.list('b').slice(0, prefix?.length)).toEqual(prefix);
    expect(queryKeys.lists().slice(0, prefix?.length)).not.toEqual(prefix);
  });
});
