import { describe, expect, it } from 'vitest';
import { itemIndexDrift, type ItemIndex } from './item-indexes';

const indexes: ItemIndex[] = [
  {
    name: 'items_pkey',
    columns: ['id'],
    unique: true,
    primary: true,
    valid: true,
    method: 'btree',
    predicate: null,
  },
  {
    name: 'items_listId_idx',
    columns: ['listId'],
    unique: false,
    primary: false,
    valid: true,
    method: 'btree',
    predicate: null,
  },
  {
    name: 'items_productId_idx',
    columns: ['productId'],
    unique: false,
    primary: false,
    valid: true,
    method: 'btree',
    predicate: null,
  },
];

describe('Item index drift contract', () => {
  it('accepts only the indexes declared by the Item schema, independent of order', () => {
    expect(itemIndexDrift([...indexes].reverse())).toEqual([]);
  });
  it.each(['items_listId_productId_variantId_key', 'renamed_duplicate_guard'])(
    'rejects a leftover UNIQUE even under another name: %s',
    (name) => {
      expect(
        itemIndexDrift([
          ...indexes,
          { ...indexes[1], name, columns: ['listId', 'productId', 'variantId'], unique: true },
        ])
      ).toEqual([expect.stringContaining(`Unexpected UNIQUE index: ${name}`)]);
    }
  );
  it.each([
    { unique: true },
    { columns: ['productId', 'listId'] },
    { valid: false },
    { method: 'hash' },
    { predicate: '"variantId" IS NOT NULL' },
  ])('rejects a changed expected index: %j', (change) => {
    expect(itemIndexDrift([indexes[0], { ...indexes[1], ...change }, indexes[2]])).toEqual([
      'Index definition differs from Item schema: items_listId_idx',
    ]);
  });
  it('rejects missing indexes, including a missing items table', () => {
    expect(itemIndexDrift([])).toHaveLength(3);
    expect(itemIndexDrift(indexes.slice(0, 2))).toEqual(['Missing index: items_productId_idx']);
  });
  it('rejects unexpected nonunique indexes too rather than hiding drift', () => {
    expect(itemIndexDrift([...indexes, { ...indexes[1], name: 'extra' }])).toEqual([
      'Unexpected index: extra (listId)',
    ]);
  });
});
