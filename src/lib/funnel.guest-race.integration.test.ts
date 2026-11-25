// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Real-PostgreSQL check for once-per-guest funnel milestones under concurrent starts.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a disposable local database, e.g.:
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:…@127.0.0.1:<port>/clickmoji_race \
 *     npx vitest run src/lib/funnel.guest-race.integration
 * The URL is refused unless it names localhost, so no shared or production database can be used.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const isLocal = url ? ['localhost', '127.0.0.1'].includes(new URL(url).hostname) : false;

if (url && isLocal) {
  process.env.DATABASE_URL = url;
}

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

const CONCURRENT_STARTS = 8;

describe.skipIf(!url || !isLocal)('funnel once-per-guest milestones on PostgreSQL', () => {
  const guestId = `guest_pg17race_${randomUUID()}`;
  const otherGuestId = `guest_pg17other_${randomUUID()}`;
  let admin: import('@prisma/client').PrismaClient;
  let userIds: string[] = [];
  let recordFunnelEvent: typeof import('./funnel').recordFunnelEvent;

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { createPrismaPgAdapter } = await import('./prisma-adapter');
    admin = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    ({ recordFunnelEvent } = await import('./funnel'));

    // Starts come from guest Users, as POST /api/auth/guest creates them. Milestone dedupe only
    // counts guest-owned rows, so these must carry isGuest = true.
    for (let index = 0; index < 2; index += 1) {
      const user = await admin.user.create({
        data: { email: `race-${randomUUID()}@example.test`, isGuest: true },
        select: { id: true },
      });
      userIds.push(user.id);
    }
  });

  afterAll(async () => {
    if (admin) {
      await admin.user.deleteMany({ where: { id: { in: userIds } } });
      await admin.$disconnect();
    }
  });

  it('records exactly one REGISTER and one LIST_CREATE when one guestId starts many times at once', async () => {
    const starts = Array.from({ length: CONCURRENT_STARTS }, (_, index) => userIds[index % 2]);

    await Promise.all(
      starts.flatMap((userId) => [
        recordFunnelEvent({
          type: 'REGISTER',
          userId,
          guestId,
          correlateGuest: true,
          dedupeByGuest: true,
        }),
        recordFunnelEvent({ type: 'LIST_CREATE', userId, guestId, dedupeByGuest: true }),
      ])
    );

    const rows = await admin.funnelEvent.findMany({
      where: { guestId },
      select: { type: true },
    });
    const counts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.type] = (acc[row.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ REGISTER: 1, LIST_CREATE: 1 });
  });

  it('keeps repeatable ITEM_ADD events and correlates the guest trail to the new user', async () => {
    await Promise.all(
      Array.from({ length: 3 }, () =>
        recordFunnelEvent({ type: 'ITEM_ADD', userId: userIds[0], guestId: otherGuestId })
      )
    );
    await recordFunnelEvent({
      type: 'REGISTER',
      userId: userIds[1],
      guestId: otherGuestId,
      correlateGuest: true,
      dedupeByGuest: true,
    });

    const itemAdds = await admin.funnelEvent.count({
      where: { guestId: otherGuestId, type: 'ITEM_ADD' },
    });
    expect(itemAdds).toBe(3);
    const correlated = await admin.funnelEvent.count({
      where: { guestId: otherGuestId, userId: userIds[1] },
    });
    expect(correlated).toBeGreaterThanOrEqual(1);
  });
});
