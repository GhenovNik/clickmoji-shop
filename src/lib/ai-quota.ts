import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Daily budget of paid AI calls per user, kept in PostgreSQL so that every server instance
// shares it. The hourly `checkRateLimit` limits stay in front of it; without Upstash they are
// counted per instance and reset on a cold start, so on their own they do not bound spend.
//
// One unit is one call to a paid provider; it is reserved right before that call. The window is
// the UTC calendar day. Routes that take units:
// - POST /api/lists/import-text: 1 (text analysis)
// - POST /api/products/smart-create: 1 (text analysis) + 1 (custom image, only when needed)
// - POST /api/emoji/generate (admin): 1 (image)
// - POST /api/products/bulk-import (admin): 1 (text analysis of the whole batch)
//
// Limit per role, read on every request:
// - AI_DAILY_CALLS_PER_USER for USER, AI_DAILY_CALLS_PER_ADMIN for ADMIN
// - unset, empty or not a plain non-negative integer: the default (30 / 300)
// - 0: paid AI is off for that role (403, no provider call)
// - N > 0: at most N units per UTC day (429 with Retry-After once used up)

export const AI_DAILY_CALLS_DEFAULTS = { USER: 30, ADMIN: 300 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

type Role = string | null | undefined;

export type AiQuotaDecision =
  | { allowed: true; used: number; limit: number }
  | { allowed: false; limit: number; resetAt: number };

export function aiDailyLimit(role: Role): number {
  const isAdmin = role === 'ADMIN';
  const raw = isAdmin ? process.env.AI_DAILY_CALLS_PER_ADMIN : process.env.AI_DAILY_CALLS_PER_USER;
  const value = raw?.trim() ?? '';
  if (/^\d+$/.test(value)) return Number(value);
  return isAdmin ? AI_DAILY_CALLS_DEFAULTS.ADMIN : AI_DAILY_CALLS_DEFAULTS.USER;
}

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Atomically takes one unit of today's budget. The conditional upsert never lets concurrent
 * requests push the counter past the limit: a denied request leaves the counter unchanged.
 */
export async function reserveAiCall({
  userId,
  role,
  now = new Date(),
}: {
  userId: string;
  role: Role;
  now?: Date;
}): Promise<AiQuotaDecision> {
  const limit = aiDailyLimit(role);
  const windowStart = startOfUtcDay(now);
  const resetAt = windowStart.getTime() + DAY_MS;

  if (limit === 0) return { allowed: false, limit, resetAt };

  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO ai_usage_counters ("userId", "windowStart", "count", "updatedAt")
    VALUES (${userId}, ${windowStart}, 1, NOW())
    ON CONFLICT ("userId", "windowStart") DO UPDATE
      SET "count" = ai_usage_counters."count" + 1, "updatedAt" = NOW()
      WHERE ai_usage_counters."count" < ${limit}
    RETURNING "count"`;

  if (rows.length === 0) return { allowed: false, limit, resetAt };
  return { allowed: true, used: Number(rows[0].count), limit };
}

/**
 * Route helper: null when the paid call may proceed, otherwise the response to return instead of
 * making it: 403 when paid AI is off for the role, 429 when today's budget is used up, 503 when the
 * budget cannot be checked (database error, migration not applied). A route that has already made
 * a paid call may treat a non-null result as "skip the optional next call" instead (smart-create's
 * image), see docs/ai.md.
 */
export async function enforceAiQuota(user: { id: string; role: Role }): Promise<Response | null> {
  let decision: AiQuotaDecision;
  try {
    decision = await reserveAiCall({ userId: user.id, role: user.role });
  } catch (error) {
    console.error('AI quota check failed, refusing the paid call:', error);
    return NextResponse.json(
      { error: 'AI временно недоступен. Попробуйте позже.' },
      { status: 503 }
    );
  }

  if (decision.allowed) return null;

  if (decision.limit === 0) {
    return NextResponse.json({ error: 'AI-функции отключены для этой роли.' }, { status: 403 });
  }

  const retryAfter = Math.max(Math.ceil((decision.resetAt - Date.now()) / 1000), 1);
  return NextResponse.json(
    { error: 'Дневной лимит AI-запросов исчерпан. Попробуйте завтра.' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}
