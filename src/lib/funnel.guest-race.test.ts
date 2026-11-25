// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Offline model of the funnel table with a controlled interleaving (craft rule 25): reads take a
 * snapshot when called and return it after a delay, writes land after a delay. A transaction's
 * advisory lock is modelled as a per-key mutex held until the transaction finishes, which is the
 * behaviour `pg_advisory_xact_lock` gives inside one PostgreSQL transaction.
 */
const doubles = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; type: string; guestId: string | null; userId: string | null }>,
  locks: new Map<string, Promise<void>>(),
  updateMany: vi.fn(),
  lockKeys: [] as string[],
}));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquire(key: string): Promise<() => void> {
  const previous = doubles.locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  doubles.locks.set(
    key,
    previous.then(() => current)
  );
  await previous;
  return release;
}

function makeDelegate() {
  return {
    findFirst: async ({ where }: { where: { type: string; guestId: string } }) => {
      const snapshot =
        doubles.rows.find((row) => row.type === where.type && row.guestId === where.guestId) ??
        null;
      await wait(5);
      return snapshot ? { id: snapshot.id } : null;
    },
    create: async ({
      data,
    }: {
      data: { type: string; guestId: string | null; userId: string | null };
    }) => {
      await wait(5);
      const row = { id: `evt-${doubles.rows.length + 1}`, ...data };
      doubles.rows.push(row);
      return row;
    },
  };
}

vi.mock('@/lib/prisma', () => {
  const delegate = makeDelegate();
  const tx = {
    funnelEvent: { ...delegate, updateMany: doubles.updateMany },
    $executeRaw: async (_strings: TemplateStringsArray, lockKey: string) => {
      doubles.lockKeys.push(lockKey);
      const release = await acquire(lockKey);
      (tx as unknown as { held: Array<() => void> }).held.push(release);
      return 0;
    },
    held: [] as Array<() => void>,
  };
  const prisma = {
    funnelEvent: { ...delegate, updateMany: doubles.updateMany },
    $transaction: async <T>(run: (client: typeof tx) => Promise<T>) => {
      tx.held = [];
      try {
        return await run(tx);
      } finally {
        tx.held.forEach((release) => release());
      }
    },
  };
  return { prisma };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

const { recordFunnelEvent } = await import('./funnel');

const GUEST_ID = 'guest_race_1234567890';
const OTHER_GUEST_ID = 'guest_race_other_0987654321';

beforeEach(() => {
  doubles.rows.length = 0;
  doubles.locks.clear();
  doubles.lockKeys.length = 0;
  doubles.updateMany.mockReset().mockResolvedValue({ count: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('funnel guest milestones under concurrent first starts', () => {
  it('records exactly one REGISTER and one LIST_CREATE when the same guestId starts twice at once', async () => {
    const results = await Promise.all([
      recordFunnelEvent({
        type: 'REGISTER',
        userId: 'user-a',
        guestId: GUEST_ID,
        correlateGuest: true,
        dedupeByGuest: true,
      }),
      recordFunnelEvent({
        type: 'REGISTER',
        userId: 'user-b',
        guestId: GUEST_ID,
        correlateGuest: true,
        dedupeByGuest: true,
      }),
    ]);
    await Promise.all([
      recordFunnelEvent({
        type: 'LIST_CREATE',
        userId: 'user-a',
        guestId: GUEST_ID,
        dedupeByGuest: true,
      }),
      recordFunnelEvent({
        type: 'LIST_CREATE',
        userId: 'user-b',
        guestId: GUEST_ID,
        dedupeByGuest: true,
      }),
    ]);

    expect(doubles.rows.filter((row) => row.type === 'REGISTER')).toHaveLength(1);
    expect(doubles.rows.filter((row) => row.type === 'LIST_CREATE')).toHaveLength(1);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('still correlates the new User.id to the guest VISIT trail when the milestone was already recorded', async () => {
    await Promise.all([
      recordFunnelEvent({
        type: 'REGISTER',
        userId: 'user-a',
        guestId: GUEST_ID,
        dedupeByGuest: true,
      }),
      recordFunnelEvent({
        type: 'REGISTER',
        userId: 'user-b',
        guestId: GUEST_ID,
        correlateGuest: true,
        dedupeByGuest: true,
      }),
    ]);

    expect(doubles.updateMany).toHaveBeenCalledWith({
      where: { guestId: GUEST_ID, userId: null },
      data: { userId: 'user-b' },
    });
  });

  it('keys the transaction lock by the funnel guestId, so different guests do not serialize on each other', async () => {
    await Promise.all([
      recordFunnelEvent({
        type: 'REGISTER',
        userId: 'user-a',
        guestId: GUEST_ID,
        dedupeByGuest: true,
      }),
      recordFunnelEvent({
        type: 'REGISTER',
        userId: 'user-c',
        guestId: OTHER_GUEST_ID,
        dedupeByGuest: true,
      }),
    ]);

    expect(doubles.rows.filter((row) => row.type === 'REGISTER')).toHaveLength(2);
    expect(
      doubles.lockKeys.every((key) => key.includes(GUEST_ID) || key.includes(OTHER_GUEST_ID))
    ).toBe(true);
    expect(new Set(doubles.lockKeys).size).toBe(2);
  });

  it('keeps repeatable events (ITEM_ADD) without dedupe: each one is written', async () => {
    await Promise.all([
      recordFunnelEvent({ type: 'ITEM_ADD', userId: 'user-a', guestId: GUEST_ID }),
      recordFunnelEvent({ type: 'ITEM_ADD', userId: 'user-a', guestId: GUEST_ID }),
    ]);

    expect(doubles.rows.filter((row) => row.type === 'ITEM_ADD')).toHaveLength(2);
    expect(doubles.lockKeys).toHaveLength(0);
  });
});
