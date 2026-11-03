import { describe, expect, it } from 'vitest';
import { settleCatalogAddAttempt, type CatalogAddAttempt } from './catalog-add-attempt';

const attempt: CatalogAddAttempt = {
  attemptId: 1,
  listId: 'list-A',
  query: 'milk',
  productId: 'milk',
  exists: false,
  status: 'pending',
};

describe('catalog add attempt ownership', () => {
  it('removes the completed operation independently of UI target/version', () => {
    expect(settleCatalogAddAttempt(attempt, 1, 'succeeded')).toBeNull();
  });

  it('retains exactly the failed product/list/query for add-only retry', () => {
    expect(settleCatalogAddAttempt(attempt, 1, 'failed')).toEqual({
      ...attempt,
      status: 'failed',
    });
  });

  it.each(['pending', 'failed'] as const)(
    'ignores old success and failure after a newer %s attempt, even for the same product/list/query',
    (status) => {
      const newer = { ...attempt, attemptId: 2, status };
      expect(settleCatalogAddAttempt(newer, 1, 'succeeded')).toBe(newer);
      expect(settleCatalogAddAttempt(newer, 1, 'failed')).toBe(newer);
      expect(settleCatalogAddAttempt(newer, 2, 'succeeded')).toBeNull();
    }
  );

  it('does not resurrect a record removed by editing the query or completing the operation', () => {
    expect(settleCatalogAddAttempt(null, 1, 'succeeded')).toBeNull();
    expect(settleCatalogAddAttempt(null, 1, 'failed')).toBeNull();
  });
});
