import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Daily budget of paid AI calls per user, kept in PostgreSQL so that every server instance
// shares it. The hourly `checkRateLimit` limits stay in front of it; without Upstash they are
// counted per instance and reset on a cold start, so on their own they do not bound spend.
//
// One unit is one request that may call a paid model: a text analysis (import-text, smart-create)
// or an image generation inside smart-create. The window is the UTC calendar day.
//
// Defaults are deliberately conservative and can be changed per environment:
// - AI_DAILY_CALLS_PER_USER  (default 30)
// - AI_DAILY_CALLS_PER_ADMIN (default 300)
// A value of 0 turns paid AI off for that role.

export const AI_DAILY_CALLS_DEFAULTS = { USER: 30, ADMIN: 300 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

type Role = string | null | undefined;

export type AiQuotaDecision =
  | { allowed: true; used: number; limit: number }
  | { allowed: false; limit: number; resetAt: number };

export function aiDailyLimit(role: Role): number {
  const isAdmin = role === 'ADMIN';
  const raw = isAdmin ? process.env.AI_DAILY_CALLS_PER_ADMIN : process.env.AI_DAILY_CALLS_PER_USER;
  const parsed = Number.parseInt(raw?.trim() ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
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
 * Route helper: null when the call may proceed, otherwise the response to return. Fails closed:
 * if the budget cannot be checked (database error, migration not applied), no paid call is made.
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

  const retryAfter = Math.max(Math.ceil((decision.resetAt - Date.now()) / 1000), 1);
  return NextResponse.json(
    { error: 'Дневной лимит AI-запросов исчерпан. Попробуйте завтра.' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}
