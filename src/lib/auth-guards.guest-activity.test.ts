// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupInactiveGuests, type GuestCleanupDbClient } from './guest-cleanup';

/**
 * Guest activity before a protected request is served. The store is a small in-memory stand-in for
 * `prisma.user`, evaluating the same where-shapes the guard and cleanup send. A touch failure is a
 * rejected write, and a row removed first is a `count: 0`, so these tests cover both without a
 * database. Cleanup runs against the same store, so the race at the cutoff is ordered explicitly.
 */
const store = vi.hoisted(() => ({
  users: [] as Array<{
    id: string;
    role: 'USER' | 'ADMIN';
    isGuest: boolean;
    guestLastActiveAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
  failNextUpdate: null as Error | null,
  afterRead: null as null | (() => Promise<void>),
  auth: null as unknown,
}));

type Row = (typeof store.users)[number];

function matchesCondition(value: Date | null, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (cond && typeof cond === 'object' && 'lt' in cond) {
    return value !== null && value.getTime() < (cond as { lt: Date }).lt.getTime();
  }
  return value === cond;
}

function matchesWhere(user: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Record<string, unknown>[]).some((clause) => matchesWhere(user, clause));
    }
    if (key === 'id' && value && typeof value === 'object' && 'in' in value) {
      return (value as { in: string[] }).in.includes(user.id);
    }
    if (key === 'guestLastActiveAt' || key === 'createdAt' || key === 'updatedAt') {
      return matchesCondition(user[key], value);
    }
    return user[key as keyof Row] === value;
  });
}

vi.mock('@/lib/auth', () => ({
  auth: async () => store.auth,
}));

vi.mock('@/lib/prisma', () => {
  const user = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const found = store.users.find((row) => row.id === where.id);
      const snapshot = found ? { ...found } : null;
      if (store.afterRead) {
        const hook = store.afterRead;
        store.afterRead = null;
        await hook();
      }
      return snapshot;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: { guestLastActiveAt: Date };
    }) => {
      if (store.failNextUpdate) {
        const error = store.failNextUpdate;
        store.failNextUpdate = null;
        throw error;
      }
      let count = 0;
      for (const row of store.users) {
        if (matchesWhere(row, where)) {
          row.guestLastActiveAt = data.guestLastActiveAt;
          count += 1;
        }
      }
      return { count };
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      store.users.filter((row) => matchesWhere(row, where)).length,
    findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
      store.users
        .filter((row) => matchesWhere(row, where))
        .slice(0, take)
        .map((row) => ({ id: row.id })),
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = store.users.length;
      store.users = store.users.filter((row) => !matchesWhere(row, where));
      return { count: before - store.users.length };
    },
  };
  // The batch hand-off and delete run in one transaction; this fake has no rollback, and the
  // hand-off below is a no-op, so the callback just runs against the same in-memory rows.
  // The batch locks its candidate rows with a raw statement; the in-memory rows need no lock.
  const client: {
    user: typeof user;
    $queryRaw: () => Promise<unknown[]>;
    $transaction: (run: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  } = {
    user,
    $queryRaw: async () => [],
    $transaction: async (run) => run(client),
  };
  return { prisma: client };
});

const { requireUser } = await import('./auth-guards');
const { prisma } = await import('@/lib/prisma');

const NOW = new Date('2026-11-25T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const CUTOFF_DAYS = 30;

function seed(row: Partial<Row> & Pick<Row, 'id'>): Row {
  const created: Row = {
    role: 'USER',
    isGuest: true,
    guestLastActiveAt: minutesAgo(2),
    createdAt: daysAgo(90),
    updatedAt: daysAgo(90),
    ...row,
  };
  store.users.push(created);
  return created;
}

function sessionFor(id: string) {
  return {
    user: { id, role: 'USER', isGuest: true },
    sessionIssuedAt: Math.floor(daysAgo(90).getTime() / 1000) + 60,
  };
}

const asResponse = (value: unknown) => (value instanceof Response ? value : null);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  store.users = [];
  store.failNextUpdate = null;
  store.afterRead = null;
  store.auth = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('requireUser guest activity before a protected request', () => {
  it('serves a guest whose stale activity was persisted first', async () => {
    seed({ id: 'guest-stale', guestLastActiveAt: minutesAgo(5) });
    store.auth = sessionFor('guest-stale');

    const result = await requireUser();

    expect(asResponse(result)).toBeNull();
    expect(store.users[0].guestLastActiveAt?.getTime()).toBe(NOW.getTime());
  });

  it('refuses the request with 503 when the activity write fails, and persists nothing', async () => {
    seed({ id: 'guest-fail', guestLastActiveAt: minutesAgo(5) });
    store.auth = sessionFor('guest-fail');
    store.failNextUpdate = new Error('connection reset');

    const result = await requireUser();

    expect(asResponse(result)?.status).toBe(503);
    expect(store.users[0].guestLastActiveAt?.getTime()).toBe(minutesAgo(5).getTime());
  });

  it('refuses with 401 when the guest row is already gone (touch count 0), and does not revive it', async () => {
    seed({ id: 'guest-gone', guestLastActiveAt: minutesAgo(5) });
    store.auth = sessionFor('guest-gone');
    store.afterRead = async () => {
      store.users = store.users.filter((row) => row.id !== 'guest-gone');
    };

    const result = await requireUser();

    expect(asResponse(result)?.status).toBe(401);
    expect(store.users).toHaveLength(0);
  });

  it('serves a regular account without any activity write', async () => {
    seed({ id: 'user-regular', isGuest: false, guestLastActiveAt: null, createdAt: daysAgo(400) });
    store.auth = {
      user: { id: 'user-regular', role: 'USER', isGuest: false },
      sessionIssuedAt: Math.floor(daysAgo(400).getTime() / 1000) + 60,
    };
    const before = store.users[0].guestLastActiveAt;

    const result = await requireUser();

    expect(asResponse(result)).toBeNull();
    expect(store.users[0].guestLastActiveAt).toBe(before);
  });
});

describe('guest cleanup racing a guest request at the cutoff', () => {
  const cleanup = () =>
    cleanupInactiveGuests({
      db: prisma as unknown as GuestCleanupDbClient,
      inactiveDays: CUTOFF_DAYS,
      now: NOW,
      handOff: async () => 0,
    });

  it('a failed touch leaves the stale guest to cleanup, which removes it, and keeps the regular account', async () => {
    seed({ id: 'guest-edge', guestLastActiveAt: daysAgo(CUTOFF_DAYS + 1) });
    seed({ id: 'user-edge', isGuest: false, guestLastActiveAt: null, createdAt: daysAgo(400) });
    store.auth = sessionFor('guest-edge');
    store.failNextUpdate = new Error('timeout');

    const result = await requireUser();
    const outcome = await cleanup();

    expect(asResponse(result)?.status).toBe(503);
    expect(outcome.deletedCount).toBe(1);
    expect(store.users.map((row) => row.id)).toEqual(['user-edge']);
  });

  it('a touch that persisted first keeps the guest through cleanup at the cutoff', async () => {
    seed({ id: 'guest-edge', guestLastActiveAt: daysAgo(CUTOFF_DAYS + 1) });
    store.auth = sessionFor('guest-edge');

    const result = await requireUser();
    const outcome = await cleanup();

    expect(asResponse(result)).toBeNull();
    expect(outcome.matchedCount).toBe(0);
    expect(outcome.deletedCount).toBe(0);
    expect(store.users.map((row) => row.id)).toEqual(['guest-edge']);
  });

  it('cleanup that removes the guest between the read and the touch yields 401, not a served request', async () => {
    seed({ id: 'guest-edge', guestLastActiveAt: daysAgo(CUTOFF_DAYS + 1) });
    store.auth = sessionFor('guest-edge');
    store.afterRead = async () => {
      await cleanup();
    };

    const result = await requireUser();

    expect(asResponse(result)?.status).toBe(401);
    expect(store.users).toHaveLength(0);
  });
});
