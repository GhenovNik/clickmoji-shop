// In-memory stand-in for the Prisma models behind lists, items and history. It keeps just enough
// of Prisma's and PostgreSQL's behaviour to test list operations without a database:
// - interactive transactions roll every write back when the callback throws,
// - inserts check foreign keys (list, product, variant) like the real constraints,
// - every call is recorded in `calls` so a test can count queries,
// - `hooks.afterItemsRead` runs right after a query returns the items of a list, which lets a
//   test interleave a concurrent write at an exact point instead of sleeping.

type Row = Record<string, unknown>;

export type FakeCategory = { id: string; name: string };
export type FakeProduct = {
  id: string;
  name: string;
  emoji: string;
  imageUrl: string | null;
  isCustom: boolean;
  isGlobal: boolean;
  createdById: string | null;
  categoryId: string;
};
export type FakeVariant = { id: string; productId: string; name: string; emoji: string };
export type FakeList = { id: string; userId: string; name: string; isActive: boolean };
export type FakeItem = {
  id: string;
  listId: string;
  productId: string;
  variantId: string | null;
  note: string | null;
  isPurchased: boolean;
  createdAt: Date;
};
export type FakeHistoryItem = Row & { id: string; historyId: string };
export type FakeHistory = {
  id: string;
  userId: string;
  listId: string | null;
  listName: string;
  completedAt: Date;
};

export type FakeState = {
  categories: FakeCategory[];
  products: FakeProduct[];
  variants: FakeVariant[];
  lists: FakeList[];
  items: FakeItem[];
  histories: FakeHistory[];
  historyItems: FakeHistoryItem[];
};

export type FakeHooks = {
  afterItemsRead?: () => void;
  beforeItemInsert?: (row: FakeItem) => void;
};

export class ForeignKeyViolation extends Error {}

export function product(overrides: Partial<FakeProduct> & { id: string }): FakeProduct {
  return {
    name: overrides.id,
    emoji: '🛒',
    imageUrl: null,
    isCustom: false,
    isGlobal: true,
    createdById: null,
    categoryId: 'cat-1',
    ...overrides,
  };
}

export function createFakeListDb(seed: Partial<FakeState> = {}) {
  const state: FakeState = {
    categories: [{ id: 'cat-1', name: 'Молочное' }],
    products: [],
    variants: [],
    lists: [],
    items: [],
    histories: [],
    historyItems: [],
    ...structuredClone(seed),
  };
  const calls: string[] = [];
  const hooks: FakeHooks = {};
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;

  const productOf = (row: Row) => state.products.find((p) => p.id === row.productId) ?? null;
  const variantOf = (row: Row) => state.variants.find((v) => v.id === row.variantId) ?? null;

  // Prisma `where` subset: equality, `in`, OR/AND/NOT and the `product` relation.
  function matches(row: Row | null, where: Row = {}): boolean {
    if (!row) return false;
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return (value as Row[]).some((clause) => matches(row, clause));
      if (key === 'AND') return (value as Row[]).every((clause) => matches(row, clause));
      if (key === 'NOT') return !matches(row, value as Row);
      if (key === 'product') return matches(productOf(row), value as Row);
      if (value && typeof value === 'object' && 'in' in value) {
        return (value.in as unknown[]).includes(row[key]);
      }
      return row[key] === value;
    });
  }

  function withItemRelations(item: FakeItem, include: Row | undefined) {
    if (!include) return { ...item };
    const productRow = productOf(item);
    return {
      ...item,
      ...(include.product
        ? {
            product: productRow && {
              ...productRow,
              category: state.categories.find((c) => c.id === productRow.categoryId) ?? null,
            },
          }
        : {}),
      ...(include.variant ? { variant: variantOf(item) } : {}),
    };
  }

  function select(row: Row, fields: Row | undefined) {
    if (!fields) return row;
    return Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]));
  }

  function insertItem(data: Row): FakeItem {
    const row: FakeItem = {
      id: nextId('item'),
      listId: data.listId as string,
      productId: data.productId as string,
      variantId: (data.variantId as string | null | undefined) ?? null,
      note: (data.note as string | null | undefined) ?? null,
      isPurchased: (data.isPurchased as boolean | undefined) ?? false,
      createdAt: new Date(),
    };
    hooks.beforeItemInsert?.(row);
    if (!state.lists.some((l) => l.id === row.listId))
      throw new ForeignKeyViolation('items_listId');
    if (!productOf(row)) throw new ForeignKeyViolation('items_productId');
    if (row.variantId && !variantOf(row)) throw new ForeignKeyViolation('items_variantId');
    state.items.push(row);
    return row;
  }

  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (async (...args: A) => {
      calls.push(name);
      return fn(...args);
    }) as (...args: A) => Promise<Awaited<R>>;

  const client = {
    list: {
      findUnique: record('list.findUnique', ({ where, include }: { where: Row; include?: Row }) => {
        const list = state.lists.find((l) => matches(l as unknown as Row, where));
        if (!list) return null;
        if (!include?.items) return { ...list };
        const itemsArgs = include.items as { where?: Row; include?: Row };
        const items = state.items
          .filter((i) => i.listId === list.id && matches(i as unknown as Row, itemsArgs.where))
          .map((i) => withItemRelations(i, itemsArgs.include));
        hooks.afterItemsRead?.();
        return { ...list, items };
      }),
      create: record('list.create', ({ data }: { data: Row }) => {
        const list: FakeList = {
          id: nextId('list'),
          userId: data.userId as string,
          name: data.name as string,
          isActive: (data.isActive as boolean | undefined) ?? false,
        };
        state.lists.push(list);
        return { ...list };
      }),
    },
    item: {
      findMany: record(
        'item.findMany',
        ({ where, include, select: fields }: { where: Row; include?: Row; select?: Row }) => {
          const rows = state.items
            .filter((i) => matches(i as unknown as Row, where))
            .map((i) => select(withItemRelations(i, include), fields));
          hooks.afterItemsRead?.();
          return rows;
        }
      ),
      findFirst: record(
        'item.findFirst',
        ({ where, select: fields }: { where: Row; select?: Row }) => {
          const row = state.items.find((i) => matches(i as unknown as Row, where));
          return row ? select({ ...row }, fields) : null;
        }
      ),
      update: record(
        'item.update',
        ({ where, data, include }: { where: Row; data: Row; include?: Row }) => {
          const row = state.items.find((i) => matches(i as unknown as Row, where));
          if (!row) throw new Error('fake-list-db: record to update not found');
          Object.assign(row, data);
          return withItemRelations(row, include);
        }
      ),
      create: record('item.create', ({ data, include }: { data: Row; include?: Row }) =>
        withItemRelations(insertItem(data), include)
      ),
      createMany: record('item.createMany', ({ data }: { data: Row[] }) => {
        data.forEach(insertItem);
        return { count: data.length };
      }),
      createManyAndReturn: record(
        'item.createManyAndReturn',
        ({ data, include }: { data: Row[]; include?: Row }) =>
          data.map(insertItem).map((row) => withItemRelations(row, include))
      ),
      deleteMany: record('item.deleteMany', ({ where }: { where: Row }) => {
        const before = state.items.length;
        state.items = state.items.filter((i) => !matches(i as unknown as Row, where));
        return { count: before - state.items.length };
      }),
    },
    product: {
      findFirst: record(
        'product.findFirst',
        ({ where, select: fields }: { where: Row; select?: Row }) => {
          const row = state.products.find((p) => matches(p as unknown as Row, where));
          return row ? select({ ...row }, fields) : null;
        }
      ),
      findMany: record(
        'product.findMany',
        ({ where, select: fields }: { where: Row; select?: Row }) =>
          state.products
            .filter((p) => matches(p as unknown as Row, where))
            .map((p) => select({ ...p }, fields))
      ),
    },
    productVariant: {
      findUnique: record(
        'productVariant.findUnique',
        ({ where, select: fields }: { where: Row; select?: Row }) => {
          const row = state.variants.find((v) => matches(v as unknown as Row, where));
          return row ? select({ ...row }, fields) : null;
        }
      ),
      findMany: record(
        'productVariant.findMany',
        ({ where, select: fields }: { where: Row; select?: Row }) =>
          state.variants
            .filter((v) => matches(v as unknown as Row, where))
            .map((v) => select({ ...v }, fields))
      ),
    },
    listHistory: {
      findUnique: record('listHistory.findUnique', ({ where }: { where: Row }) => {
        const history = state.histories.find((h) => matches(h as unknown as Row, where));
        if (!history) return null;
        return {
          ...history,
          items: state.historyItems.filter((item) => item.historyId === history.id),
        };
      }),
      create: record('listHistory.create', ({ data }: { data: Row }) => {
        const history: FakeHistory = {
          id: nextId('history'),
          userId: data.userId as string,
          listId: (data.listId as string | null | undefined) ?? null,
          listName: data.listName as string,
          completedAt: (data.completedAt as Date | undefined) ?? new Date(),
        };
        state.histories.push(history);
        const nested = (data.items as { create?: Row[] } | undefined)?.create ?? [];
        const items = nested.map((item) => ({
          ...item,
          id: nextId('history-item'),
          historyId: history.id,
        }));
        state.historyItems.push(...items);
        return { ...history, items };
      }),
    },
    // Only the row locks taken by POST /api/history, recorded as `$queryRaw:<table>`:
    // - SELECT id, name FROM lists WHERE id = $1 AND "userId" = $2 FOR UPDATE
    // - SELECT id FROM items WHERE "listId" = $1 FOR UPDATE
    // A single in-memory caller never waits, so the locks themselves are no-ops.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const table = /FROM\s+(lists|items)\b/i.exec(sql)?.[1];
      if (!table || !/FOR UPDATE/i.test(sql)) {
        throw new Error(`fake-list-db: unsupported raw query: ${sql}`);
      }
      calls.push(`$queryRaw:${table}`);
      if (table === 'items') {
        return state.items.filter((i) => i.listId === values[0]).map((i) => ({ id: i.id }));
      }
      const [listId, userId] = values;
      return state.lists
        .filter((l) => l.id === listId && l.userId === userId)
        .map((l) => ({ id: l.id, name: l.name }));
    },
  };

  const prisma = {
    ...client,
    $transaction: async <T>(run: (tx: typeof client) => Promise<T>) => {
      calls.push('$transaction');
      const snapshot = structuredClone(state);
      try {
        return await run(client);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
  };

  return { prisma, state, calls, hooks };
}
