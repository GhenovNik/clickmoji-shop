import { prisma } from '@/lib/prisma';
import type { FunnelEventType } from '@/lib/funnel';

export const FUNNEL_WINDOWS = [1, 7, 30] as const;
export type FunnelWindowDays = (typeof FUNNEL_WINDOWS)[number];

export const FUNNEL_STAGES = ['visit', 'auth', 'listCreate', 'itemAdd', 'itemPurchase'] as const;
export type FunnelStageKey = (typeof FUNNEL_STAGES)[number];

export type FunnelEventRecord = {
  type: FunnelEventType;
  guestId: string | null;
  userId: string | null;
  createdAt: Date;
  /** Whether the event's User is a server-backed guest. Unknown (null/undefined) counts as not a guest. */
  userIsGuest?: boolean | null;
};

export type FunnelStageSummary = {
  stage: FunnelStageKey;
  count: number;
  /** Conversion rate from the immediately preceding stage (0..1), or null for entry/empty denominator. */
  transitionRate: number | null;
};

export type FunnelWindowSummary = {
  days: FunnelWindowDays;
  windowStart: string;
  windowEnd: string;
  stages: FunnelStageSummary[];
  /** Overall conversion from visit to purchased (0..1), or null when visit count is zero. */
  overallRate: number | null;
};

export type FunnelReport = {
  generatedAt: string;
  windows: FunnelWindowSummary[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const STAGE_INDEX: Record<FunnelEventType, number> = {
  VISIT: 0,
  REGISTER: 1,
  LOGIN: 1,
  LIST_CREATE: 2,
  ITEM_ADD: 3,
  ITEM_PURCHASE: 4,
};

function compareEvents(left: FunnelEventRecord, right: FunnelEventRecord): number {
  const timeDiff = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return STAGE_INDEX[left.type] - STAGE_INDEX[right.type];
}

type GuestUserLink = {
  userId: string;
  createdAtMs: number;
};

function buildGuestLinks(sortedEvents: FunnelEventRecord[]): Map<string, GuestUserLink[]> {
  const links = new Map<string, GuestUserLink[]>();
  for (const event of sortedEvents) {
    if (!event.guestId || !event.userId || event.userIsGuest) continue;
    const list = links.get(event.guestId);
    const entry = { userId: event.userId, createdAtMs: event.createdAt.getTime() };
    if (list) {
      list.push(entry);
    } else {
      links.set(event.guestId, [entry]);
    }
  }
  return links;
}

/**
 * Identity of the person behind an event. A server-backed guest is one funnel chain per browser:
 * a restarted guest session creates a new guest User, and concurrent starts can create several, but
 * they all carry the same funnel guestId. So every event of a guest User is keyed by that guestId,
 * and the chain counts as one person whichever User row wrote a step. Events of ordinary users keep
 * their User.id key, and a visit without a User is linked to a non-guest user only.
 */
function resolvePersonKey(
  event: FunnelEventRecord,
  guestLinks: Map<string, GuestUserLink[]>
): string | null {
  if (event.guestId && event.userIsGuest) {
    return `guest:${event.guestId}`;
  }
  if (event.userId) {
    return `user:${event.userId}`;
  }
  if (!event.guestId) {
    return null;
  }

  const candidates = guestLinks.get(event.guestId);
  if (candidates) {
    const eventTimeMs = event.createdAt.getTime();
    const match = candidates.find((candidate) => candidate.createdAtMs >= eventTimeMs);
    if (match) {
      return `user:${match.userId}`;
    }
  }

  return `guest:${event.guestId}`;
}

export function aggregateFunnelWindow(
  events: FunnelEventRecord[],
  days: FunnelWindowDays,
  now: Date = new Date()
): FunnelWindowSummary {
  const windowEndMs = now.getTime();
  const windowStartMs = windowEndMs - days * MS_PER_DAY;
  const windowStart = new Date(windowStartMs);
  const windowEnd = new Date(windowEndMs);

  const sortedAll = [...events]
    .filter((event) => event.createdAt.getTime() <= windowEndMs)
    .sort(compareEvents);
  const guestLinks = buildGuestLinks(sortedAll);

  const inWindow = sortedAll.filter((event) => event.createdAt.getTime() >= windowStartMs);

  // A step counts only when it is the next stage AND its timestamp is strictly later than the
  // previous counted step. Equal timestamps do not prove order, so they never create progression.
  const personProgress = new Map<string, { stage: number; atMs: number }>();
  for (const event of inWindow) {
    const personKey = resolvePersonKey(event, guestLinks);
    if (!personKey) continue;

    const stageIndex = STAGE_INDEX[event.type];
    const eventMs = event.createdAt.getTime();
    const current = personProgress.get(personKey);
    const currentStage = current?.stage ?? -1;
    if (stageIndex === currentStage + 1 && (!current || eventMs > current.atMs)) {
      personProgress.set(personKey, { stage: stageIndex, atMs: eventMs });
    }
  }

  const counts = FUNNEL_STAGES.map(() => 0);
  for (const { stage: maxStage } of personProgress.values()) {
    for (let stage = 0; stage <= maxStage; stage += 1) {
      counts[stage] += 1;
    }
  }

  const stages: FunnelStageSummary[] = FUNNEL_STAGES.map((stage, index) => {
    const count = counts[index];
    if (index === 0) {
      return { stage, count, transitionRate: null };
    }
    const previousCount = counts[index - 1];
    return {
      stage,
      count,
      transitionRate: previousCount > 0 ? count / previousCount : null,
    };
  });

  const visitCount = counts[0];
  const purchaseCount = counts[FUNNEL_STAGES.length - 1];

  return {
    days,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    stages,
    overallRate: visitCount > 0 ? purchaseCount / visitCount : null,
  };
}

export function buildFunnelReport(
  events: FunnelEventRecord[],
  now: Date = new Date()
): FunnelReport {
  return {
    generatedAt: now.toISOString(),
    windows: FUNNEL_WINDOWS.map((days) => aggregateFunnelWindow(events, days, now)),
  };
}

/** Columns the report reads, shared with the database-backed tests so both see the same records. */
export const FUNNEL_EVENT_REPORT_SELECT = {
  type: true,
  guestId: true,
  userId: true,
  createdAt: true,
  user: { select: { isGuest: true } },
} as const;

export type FunnelEventReportRow = {
  type: FunnelEventType;
  guestId: string | null;
  userId: string | null;
  createdAt: Date;
  user: { isGuest: boolean } | null;
};

export function toFunnelEventRecords(rows: FunnelEventReportRow[]): FunnelEventRecord[] {
  return rows.map((row) => ({
    type: row.type,
    guestId: row.guestId,
    userId: row.userId,
    createdAt: row.createdAt,
    userIsGuest: row.user?.isGuest ?? null,
  }));
}

export async function getFunnelReport(now: Date = new Date()): Promise<FunnelReport> {
  const maxDays = FUNNEL_WINDOWS[FUNNEL_WINDOWS.length - 1];
  const earliestWindowStart = new Date(now.getTime() - maxDays * MS_PER_DAY);

  const rows = await prisma.funnelEvent.findMany({
    where: {
      createdAt: {
        gte: earliestWindowStart,
        lte: now,
      },
    },
    select: FUNNEL_EVENT_REPORT_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return buildFunnelReport(toFunnelEventRecords(rows), now);
}
