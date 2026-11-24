// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  aggregateFunnelWindow,
  buildFunnelReport,
  type FunnelEventRecord,
} from './funnel-analytics';
import type { FunnelEventType } from './funnel';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

function event(
  type: FunnelEventType,
  createdAt: Date,
  ids: { userId?: string | null; guestId?: string | null }
): FunnelEventRecord {
  return {
    type,
    createdAt,
    userId: ids.userId ?? null,
    guestId: ids.guestId ?? null,
  };
}

describe('funnel-analytics ordered distinct aggregation', () => {
  it('handles empty event sets with zero counts and null transition rates', () => {
    const report = buildFunnelReport([], NOW);

    expect(report.windows.map((w) => w.days)).toEqual([1, 7, 30]);
    for (const window of report.windows) {
      expect(window.overallRate).toBeNull();
      expect(window.stages).toEqual([
        { stage: 'visit', count: 0, transitionRate: null },
        { stage: 'auth', count: 0, transitionRate: null },
        { stage: 'listCreate', count: 0, transitionRate: null },
        { stage: 'itemAdd', count: 0, transitionRate: null },
        { stage: 'itemPurchase', count: 0, transitionRate: null },
      ]);
    }
  });

  it('counts unique people in strict stage order, deduplicating repeated actions', () => {
    const events: FunnelEventRecord[] = [
      // Person 1: completes all 5 steps with repeated visits, logins, lists, items, purchases.
      event('VISIT', hoursAgo(10), { guestId: 'guest-p1' }),
      event('VISIT', hoursAgo(9), { guestId: 'guest-p1' }),
      event('REGISTER', hoursAgo(8), { guestId: 'guest-p1', userId: 'user-1' }),
      event('LOGIN', hoursAgo(7), { guestId: 'guest-p1', userId: 'user-1' }),
      event('LIST_CREATE', hoursAgo(7.5), { userId: 'user-1' }),
      event('LIST_CREATE', hoursAgo(6), { userId: 'user-1' }),
      event('ITEM_ADD', hoursAgo(5), { userId: 'user-1' }),
      event('ITEM_ADD', hoursAgo(4), { userId: 'user-1' }),
      event('ITEM_PURCHASE', hoursAgo(3), { userId: 'user-1' }),
      event('ITEM_PURCHASE', hoursAgo(2), { userId: 'user-1' }),

      // Person 2: visits, registers, creates list, stops before itemAdd.
      event('VISIT', hoursAgo(12), { guestId: 'guest-p2' }),
      event('REGISTER', hoursAgo(11), { guestId: 'guest-p2', userId: 'user-2' }),
      event('LIST_CREATE', hoursAgo(10.5), { userId: 'user-2' }),

      // Person 3: visits anonymously and drops off.
      event('VISIT', hoursAgo(15), { guestId: 'guest-p3' }),

      // Person 4: out-of-order (purchased before visiting, never repeated after visit).
      event('ITEM_ADD', hoursAgo(20), { userId: 'user-4' }),
      event('ITEM_PURCHASE', hoursAgo(19), { userId: 'user-4' }),
      event('VISIT', hoursAgo(18), { guestId: 'guest-p4', userId: 'user-4' }),
      event('LOGIN', hoursAgo(17), { guestId: 'guest-p4', userId: 'user-4' }),

      // Person 5: skipped auth step (visit -> listCreate without auth in window).
      event('VISIT', hoursAgo(16), { guestId: 'guest-p5', userId: 'user-5' }),
      event('LIST_CREATE', hoursAgo(14), { userId: 'user-5' }),
      event('ITEM_ADD', hoursAgo(13), { userId: 'user-5' }),
    ];

    const summary = aggregateFunnelWindow(events, 1, NOW);

    expect(summary.stages.map((s) => [s.stage, s.count])).toEqual([
      ['visit', 5],
      ['auth', 3],
      ['listCreate', 2],
      ['itemAdd', 1],
      ['itemPurchase', 1],
    ]);
    expect(summary.stages[0].transitionRate).toBeNull();
    expect(summary.stages[1].transitionRate).toBeCloseTo(3 / 5);
    expect(summary.stages[2].transitionRate).toBeCloseTo(2 / 3);
    expect(summary.stages[3].transitionRate).toBeCloseTo(1 / 2);
    expect(summary.stages[4].transitionRate).toBeCloseTo(1);
    expect(summary.overallRate).toBeCloseTo(1 / 5);
  });

  it('handles zero denominator at intermediate stages cleanly', () => {
    const events: FunnelEventRecord[] = [event('VISIT', hoursAgo(5), { guestId: 'guest-only' })];

    const summary = aggregateFunnelWindow(events, 1, NOW);

    expect(summary.stages).toEqual([
      { stage: 'visit', count: 1, transitionRate: null },
      { stage: 'auth', count: 0, transitionRate: 0 },
      { stage: 'listCreate', count: 0, transitionRate: null },
      { stage: 'itemAdd', count: 0, transitionRate: null },
      { stage: 'itemPurchase', count: 0, transitionRate: null },
    ]);
    expect(summary.overallRate).toBe(0);
  });

  it('isolates shared-browser guest IDs across different users in chronological order', () => {
    const events: FunnelEventRecord[] = [
      event('VISIT', hoursAgo(10), { guestId: 'shared-browser', userId: 'user-a' }),
      event('LOGIN', hoursAgo(9), { guestId: 'shared-browser', userId: 'user-a' }),
      // Later another person visits anonymously on the same browser and logs in as user-b.
      event('VISIT', hoursAgo(5), { guestId: 'shared-browser', userId: null }),
      event('LOGIN', hoursAgo(4), { guestId: 'shared-browser', userId: 'user-b' }),
    ];

    const summary = aggregateFunnelWindow(events, 1, NOW);

    expect(summary.stages.slice(0, 2).map((s) => s.count)).toEqual([2, 2]);
  });

  it('computes rolling 1, 7, and 30-day windows accurately', () => {
    const events: FunnelEventRecord[] = [
      // Within 1 day: user-1d completes 3 stages.
      event('VISIT', hoursAgo(6), { guestId: 'g-1d' }),
      event('REGISTER', hoursAgo(5), { guestId: 'g-1d', userId: 'user-1d' }),
      event('LIST_CREATE', hoursAgo(4.5), { userId: 'user-1d' }),

      // 4 days ago (in 7d and 30d, not 1d): user-7d completes 4 stages.
      event('VISIT', daysAgo(4), { guestId: 'g-7d' }),
      event('LOGIN', daysAgo(3.9), { guestId: 'g-7d', userId: 'user-7d' }),
      event('LIST_CREATE', daysAgo(3), { userId: 'user-7d' }),
      event('ITEM_ADD', daysAgo(2.9), { userId: 'user-7d' }),

      // 20 days ago (in 30d only): user-30d completes 5 stages.
      event('VISIT', daysAgo(20), { guestId: 'g-30d' }),
      event('REGISTER', daysAgo(19.9), { guestId: 'g-30d', userId: 'user-30d' }),
      event('LIST_CREATE', daysAgo(19), { userId: 'user-30d' }),
      event('ITEM_ADD', daysAgo(18), { userId: 'user-30d' }),
      event('ITEM_PURCHASE', daysAgo(17.9), { userId: 'user-30d' }),

      // 31 days ago (outside all rolling windows).
      event('VISIT', daysAgo(31), { guestId: 'g-old', userId: 'user-old' }),
    ];

    const report = buildFunnelReport(events, NOW);
    const byDays = Object.fromEntries(
      report.windows.map((w) => [w.days, w.stages.map((s) => s.count)])
    );

    expect(byDays[1]).toEqual([1, 1, 1, 0, 0]);
    expect(byDays[7]).toEqual([2, 2, 2, 1, 0]);
    expect(byDays[30]).toEqual([3, 3, 3, 2, 1]);
  });

  it('never credits a later step that shares the previous step timestamp, in any input order', () => {
    const sameMoment = hoursAgo(5);
    const shared: FunnelEventRecord[] = [
      event('VISIT', hoursAgo(10), { guestId: 'guest-tie' }),
      event('REGISTER', hoursAgo(9), { guestId: 'guest-tie', userId: 'user-tie' }),
      // Both steps carry the same millisecond; the source does not prove which one came first.
      event('LIST_CREATE', sameMoment, { userId: 'user-tie' }),
      event('ITEM_ADD', sameMoment, { userId: 'user-tie' }),
    ];
    const reversed = [...shared].reverse();

    const forward = aggregateFunnelWindow(shared, 1, NOW);
    const backward = aggregateFunnelWindow(reversed, 1, NOW);

    expect(forward.stages.map((s) => s.count)).toEqual([1, 1, 1, 0, 0]);
    expect(backward.stages).toEqual(forward.stages);
  });

  it('credits the later step once its timestamp is strictly after the previous step', () => {
    const events: FunnelEventRecord[] = [
      event('VISIT', hoursAgo(10), { guestId: 'guest-strict' }),
      event('REGISTER', hoursAgo(9), { guestId: 'guest-strict', userId: 'user-strict' }),
      event('LIST_CREATE', hoursAgo(5), { userId: 'user-strict' }),
      event('ITEM_ADD', new Date(hoursAgo(5).getTime() + 1), { userId: 'user-strict' }),
    ];

    const summary = aggregateFunnelWindow([...events].reverse(), 1, NOW);

    expect(summary.stages.map((s) => s.count)).toEqual([1, 1, 1, 1, 0]);
  });
});
