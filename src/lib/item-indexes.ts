export type ItemIndex = {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  valid: boolean;
  method: string;
  predicate: string | null;
  definition: string;
};

// Keep in sync with model Item in prisma/schema.prisma. In particular, no
// (listId, productId, variantId) uniqueness: separate shopping rows are intentional.
const expected: ItemIndex[] = [
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

export function itemIndexDrift(indexes: ItemIndex[]): string[] {
  const problems: string[] = [];
  for (const index of indexes) {
    const wanted = expected.find((candidate) => candidate.name === index.name);
    if (!wanted) {
      problems.push(
        `Unexpected ${index.unique ? 'UNIQUE ' : ''}index: ${index.name} (${index.columns.join(', ')})`
      );
    } else if (
      index.unique !== wanted.unique ||
      index.primary !== wanted.primary ||
      index.valid !== wanted.valid ||
      index.method !== wanted.method ||
      index.predicate !== wanted.predicate ||
      index.definition !== wanted.definition ||
      JSON.stringify(index.columns) !== JSON.stringify(wanted.columns)
    ) {
      problems.push(`Index definition differs from Item schema: ${index.name}`);
    }
  }
  for (const wanted of expected) {
    if (!indexes.some((index) => index.name === wanted.name))
      problems.push(`Missing index: ${wanted.name}`);
  }
  return problems;
}
