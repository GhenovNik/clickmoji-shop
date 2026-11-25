// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupInactiveGuests,
  DEFAULT_GUEST_INACTIVE_DAYS,
  GUEST_CLEANUP_INACTIVE_DAYS_ENV,
  resolveGuestInactiveDays,
  type GuestCleanupDbClient,
} from './guest-cleanup';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

type FakeUser = {
  id: string;
  role: 'USER' | 'ADMIN';
  isGuest: boolean;
  guestLastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function matchesCondition(value: Date | null, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (cond && typeof cond === 'object' && 'lt' in cond) {
    return value !== null && value.getTime() < (cond as { lt: Date }).lt.getTime();
  }
  return value === cond;
}

function matchesWhere(user: FakeUser, where: Record<string, unknown>): boolean {
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
    return user[key as keyof FakeUser] === value;
  });
}

function createFakeDb(seed: FakeUser[], hooks?: { beforeDelete?: (users: FakeUser[]) => void }) {
  const users = [...seed];
  const db: GuestCleanupDbClient = {
    user: {
      count: async ({ where }) =>
        users.filter((u) => matchesWhere(u, where as Record<string, unknown>)).length,
      findMany: async ({ where, take }) =>
        users
          .filter((u) => matchesWhere(u, where as Record<string, unknown>))
          .slice(0, take)
          .map((u) => ({ id: u.id })),
      deleteMany: async ({ where }) => {
        hooks?.beforeDelete?.(users);
        let deleted = 0;
        for (let i = users.length - 1; i >= 0; i -= 1) {
          if (matchesWhere(users[i], where as Record<string, unknown>)) {
            users.splice(i, 1);
            deleted += 1;
          }
        }
        return { count: deleted };
      },
    },
  };
  return { db, users };
}

beforeEach(() => {
  delete process.env[GUEST_CLEANUP_INACTIVE_DAYS_ENV];
});

afterEach(() => {
  delete process.env[GUEST_CLEANUP_INACTIVE_DAYS_ENV];
  vi.restoreAllMocks();
});

describe('resolveGuestInactiveDays', () => {
  it('defaults to 30 days and supports env/explicit positive integer overrides', () => {
    expect(resolveGuestInactiveDays()).toBe(DEFAULT_GUEST_INACTIVE_DAYS);
    process.env[GUEST_CLEANUP_INACTIVE_DAYS_ENV] = '14';
    expect(resolveGuestInactiveDays()).toBe(14);
    expect(resolveGuestInactiveDays('7')).toBe(7);
    expect(resolveGuestInactiveDays(45)).toBe(45);
  });

  it('fails closed on zero, negative, fractional or malformed thresholds', () => {
    for (const invalid of [0, -1, 1.5, NaN, '0', '-10', '14days', 'abc', '']) {
      expect(() => resolveGuestInactiveDays(invalid)).toThrow(/Invalid guest inactive days/);
    }
  });
});

describe('cleanupInactiveGuests', () => {
  it('deletes only inactive guests while protecting regular users, admins, and active/recent guests', async () => {
    const seed: FakeUser[] = [
      {
        id: 'guest-inactive',
        role: 'USER',
        isGuest: true,
        guestLastActiveAt: daysAgo(15),
        createdAt: daysAgo(20),
        updatedAt: daysAgo(15),
      },
      {
        id: 'guest-null-activity-old',
        role: 'USER',
        isGuest: true,
        guestLastActiveAt: null,
        createdAt: daysAgo(30),
        updatedAt: daysAgo(25),
      },
      {
        id: 'guest-exact-boundary',
        role: 'USER',
        isGuest: true,
        guestLastActiveAt: daysAgo(14),
        createdAt: daysAgo(30),
        updatedAt: daysAgo(14),
      },
      {
        id: 'guest-recent',
        role: 'USER',
        isGuest: true,
        guestLastActiveAt: daysAgo(3),
        createdAt: daysAgo(40),
        updatedAt: daysAgo(3),
      },
      {
        id: 'regular-old',
        role: 'USER',
        isGuest: false,
        guestLastActiveAt: null,
        createdAt: daysAgo(120),
        updatedAt: daysAgo(120),
      },
      {
        id: 'admin-old',
        role: 'ADMIN',
        isGuest: false,
        guestLastActiveAt: null,
        createdAt: daysAgo(365),
        updatedAt: daysAgo(365),
      },
    ];
    const { db, users } = createFakeDb(seed);

    const result = await cleanupInactiveGuests({ db, inactiveDays: 14, now: NOW });

    expect(result).toEqual({
      inactiveDays: 14,
      cutoff: daysAgo(14),
      dryRun: false,
      matchedCount: 2,
      deletedCount: 2,
    });
    expect(users.map((u) => u.id)).toEqual([
      'guest-exact-boundary',
      'guest-recent',
      'regular-old',
      'admin-old',
    ]);
  });

  it('counts without deleting in dryRun mode', async () => {
    const { db, users } = createFakeDb([
      {
        id: 'guest-stale',
        role: 'USER',
        isGuest: true,
        guestLastActiveAt: daysAgo(31),
        createdAt: daysAgo(35),
        updatedAt: daysAgo(31),
      },
    ]);

    const result = await cleanupInactiveGuests({ db, inactiveDays: 30, dryRun: true, now: NOW });

    expect(result.matchedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(users).toHaveLength(1);
  });

  it('re-checks eligibility during deleteMany so a guest that became active or converted is kept', async () => {
    const { db, users } = createFakeDb(
      [
        {
          id: 'guest-raced',
          role: 'USER',
          isGuest: true,
          guestLastActiveAt: daysAgo(31),
          createdAt: daysAgo(40),
          updatedAt: daysAgo(31),
        },
      ],
      {
        beforeDelete: (rows) => {
          // Simulates the guest touching activity or converting to a regular account mid-job.
          rows[0].guestLastActiveAt = NOW;
          rows[0].isGuest = false;
        },
      }
    );

    const result = await cleanupInactiveGuests({ db, inactiveDays: 30, now: NOW });

    expect(result.matchedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(users).toHaveLength(1);
  });

  it('processes deletions across multiple batches', async () => {
    const seed: FakeUser[] = Array.from({ length: 5 }, (_, i) => ({
      id: `guest-${i}`,
      role: 'USER',
      isGuest: true,
      guestLastActiveAt: daysAgo(40),
      createdAt: daysAgo(40),
      updatedAt: daysAgo(40),
    }));
    const { db, users } = createFakeDb(seed);

    const result = await cleanupInactiveGuests({ db, inactiveDays: 30, batchSize: 2, now: NOW });

    expect(result.matchedCount).toBe(5);
    expect(result.deletedCount).toBe(5);
    expect(users).toHaveLength(0);
  });
});
