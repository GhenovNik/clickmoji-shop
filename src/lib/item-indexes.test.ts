import { describe, expect, it } from 'vitest';
import { itemIndexDrift, type ItemIndex } from './item-indexes';

const indexes: ItemIndex[] = [
  {
    name: 'items_pkey',
    definition: 'CREATE UNIQUE INDEX items_pkey ON public.items USING btree (id)',
    columns: ['id'],
    unique: true,
    primary: true,
    valid: true,
    method: 'btree',
    predicate: null,
  },
  {
    name: 'items_listId_idx',
    definition: 'CREATE INDEX "items_listId_idx" ON public.items USING btree ("listId")',
    columns: ['listId'],
    unique: false,
    primary: false,
    valid: true,
    method: 'btree',
    predicate: null,
  },
  {
    name: 'items_productId_idx',
    definition: 'CREATE INDEX "items_productId_idx" ON public.items USING btree ("productId")',
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
  it.each([
    '"listId" DESC',
    '"listId" NULLS FIRST',
    '"listId" text_pattern_ops',
    '"listId" COLLATE "C"',
  ])('checks the full canonical key definition, not just attname: %s', (key) => {
    const actual = indexes.map((index) => ({
      ...index,
      definition: index.definition,
    }));
    actual[1].definition = `CREATE INDEX "items_listId_idx" ON public.items USING btree (${key})`;
    expect(itemIndexDrift(actual)).toEqual([
      'Index definition differs from Item schema: items_listId_idx',
    ]);
  });
});
