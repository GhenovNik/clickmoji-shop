// In-memory stand-in for the Prisma models behind starter-list initialization. It persists
// `lists` rows, records every call, and models the PostgreSQL user-row lock closely enough for
// two overlapping requests to serialize: a transaction that selects the same user row
// `FOR UPDATE` waits until the transaction holding it commits. The `beforeListCreateMany` hook
// pauses a caller immediately before rows are written, so a test can force the overlap at an
// exact point instead of sleeping.

type Row = Record<string, unknown>;

export type FakeInitList = {
  id: string;
  name: string;
  isActive: boolean;
  userId: string;
  createdAt: Date;
};

export type FakeInitHooks = {
  beforeListCreateMany?: (userId: string) => Promise<void> | void;
  onUserLockWait?: (userId: string) => void;
};

type FindManyArgs = { where?: Row; include?: Row; orderBy?: Row };
type CreateManyArgs = { data: Row[] };

export type FakeInitTx = {
  list: {
    findMany: (args?: FindManyArgs) => Promise<Row[]>;
    createMany: (args: CreateManyArgs) => Promise<{ count: number }>;
  };
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;
};

export function createFakeInitDb(seed: { lists?: FakeInitList[] } = {}) {
  const state: { lists: FakeInitList[] } = {
    lists: (seed.lists ?? []).map((row) => ({ ...row })),
  };
  const calls: string[] = [];
  const hooks: FakeInitHooks = {};
  const lockTails = new Map<string, Promise<void>>();
  let sequence = 0;

  function matchesList(list: FakeInitList, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'in' in value) {
        return (value.in as unknown[]).includes(list[key as keyof FakeInitList]);
      }
      return list[key as keyof FakeInitList] === value;
    });
  }

  async function findMany(args: FindManyArgs = {}): Promise<Row[]> {
    calls.push('list.findMany');
    const rows = state.lists
      .filter((list) => matchesList(list, args.where))
      .map((list) => ({
        ...list,
        ...(args.include?._count ? { _count: { items: 0 } } : {}),
      }));
    if (args.orderBy && 'createdAt' in args.orderBy) {
      rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    }
    return rows;
  }

  async function createMany({ data }: CreateManyArgs): Promise<{ count: number }> {
    calls.push('list.createMany');
    const userId = (data[0]?.userId as string | undefined) ?? '';
    await hooks.beforeListCreateMany?.(userId);
    for (const row of data) {
      sequence += 1;
      state.lists.push({
        id: `list-${sequence}`,
        name: row.name as string,
        isActive: Boolean(row.isActive),
        userId: row.userId as string,
        createdAt: new Date(Date.UTC(2026, 0, 1) + sequence * 1000),
      });
    }
    return { count: data.length };
  }

  // The lock is a per-user queue: a caller waits for the previous holder to release before it
  // continues. Release happens when the surrounding transaction commits or rolls back.
  async function acquireUserLock(userId: string): Promise<() => void> {
    const previous = lockTails.get(userId);
    if (previous) hooks.onUserLockWait?.(userId);
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const tail = (previous ?? Promise.resolve()).then(() => held);
    lockTails.set(userId, tail);
    await (previous ?? Promise.resolve());
    return () => {
      releaseHeld();
      if (lockTails.get(userId) === tail) lockTails.delete(userId);
    };
  }

  async function $transaction<T>(run: (tx: FakeInitTx) => Promise<T>): Promise<T> {
    calls.push('$transaction');
    const snapshot = state.lists.map((row) => ({ ...row }));
    const releases: Array<() => void> = [];
    const tx: FakeInitTx = {
      list: { findMany, createMany },
      $queryRaw: async (strings, ...values) => {
        const sql = strings.join('?');
        const table = /FROM\s+(users|lists)\b/i.exec(sql)?.[1];
        if (!table || !/FOR UPDATE/i.test(sql)) {
          throw new Error(`fake-init-db: unsupported raw query: ${sql}`);
        }
        calls.push(`$queryRaw:${table}`);
        if (table === 'users') {
          releases.push(await acquireUserLock(String(values[0])));
          return [{ id: String(values[0]) }];
        }
        return [];
      },
    };

    try {
      const result = await run(tx);
      releases.forEach((release) => release());
      return result;
    } catch (error) {
      state.lists = snapshot;
      releases.forEach((release) => release());
      throw error;
    }
  }

  return {
    prisma: { list: { findMany, createMany }, $transaction },
    state,
    calls,
    hooks,
  };
}
