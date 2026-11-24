import { prisma } from '@/lib/prisma';
import { MICRO_USD_PER_USD } from '@/lib/ai-pricing';
import { textAiErrorCode } from '@/lib/services/text-ai-errors';

export const AI_MONTHLY_BUDGET_USD_ENV = 'AI_MONTHLY_BUDGET_USD';
export const DEFAULT_AI_MONTHLY_BUDGET_USD = 10;
export const DEFAULT_AI_MONTHLY_BUDGET_MICRO_USD =
  BigInt(DEFAULT_AI_MONTHLY_BUDGET_USD) * MICRO_USD_PER_USD;
export const MAX_AI_MONTHLY_BUDGET_USD = 1_000_000;

const DECIMAL_USD_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

export type MonthlyBudgetDbClient = Pick<typeof prisma, '$queryRaw'>;

export type MonthlyBudgetAccountingReason =
  'invalid_settlement_amount' | 'settlement_mismatch' | 'reconciliation_db_error';

/**
 * Sanitized error thrown when monthly budget reconciliation cannot prove a matching settlement.
 * Never carries raw database error messages, SQL text, keys, or prompts.
 */
export class MonthlyBudgetAccountingError extends Error {
  readonly code = 'MONTHLY_BUDGET_RECONCILIATION_FAILED';
  readonly reason: MonthlyBudgetAccountingReason;

  constructor(reason: MonthlyBudgetAccountingReason) {
    super(`Monthly AI budget accounting failed (${reason})`);
    this.name = 'MonthlyBudgetAccountingError';
    this.reason = reason;
  }
}

export type ParsedMonthlyBudget =
  { ok: true; limitMicroUsd: bigint } | { ok: false; code: 'INVALID_MONTHLY_BUDGET' };

export type MonthlyBudgetReservation =
  | {
      allowed: true;
      monthStart: Date;
      ceilingMicroUsd: bigint;
      limitMicroUsd: bigint;
      reservedMicroUsd: bigint;
      spentMicroUsd: bigint;
    }
  | {
      allowed: false;
      reason: 'invalid_config' | 'exhausted';
      resetAt: number;
      limitMicroUsd?: bigint;
    };

export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Parses AI_MONTHLY_BUDGET_USD into integer micro-USD (1 USD = 1_000_000 micro-USD).
 * - Unset, empty or whitespace-only uses DEFAULT_AI_MONTHLY_BUDGET_MICRO_USD ($10.00).
 * - "0" disables paid AI under the monthly cap.
 * - Any malformed or out-of-range value fails closed without logging the raw value.
 */
export function parseMonthlyBudgetMicroUsd(): ParsedMonthlyBudget {
  const raw = process.env[AI_MONTHLY_BUDGET_USD_ENV];
  if (raw === undefined) {
    return { ok: true, limitMicroUsd: DEFAULT_AI_MONTHLY_BUDGET_MICRO_USD };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, limitMicroUsd: DEFAULT_AI_MONTHLY_BUDGET_MICRO_USD };
  }

  const match = DECIMAL_USD_PATTERN.exec(trimmed);
  if (!match) {
    return { ok: false, code: 'INVALID_MONTHLY_BUDGET' };
  }

  const [wholePart, fracPart = ''] = trimmed.split('.');
  const wholeUsd = BigInt(wholePart);
  if (wholeUsd > BigInt(MAX_AI_MONTHLY_BUDGET_USD)) {
    return { ok: false, code: 'INVALID_MONTHLY_BUDGET' };
  }

  const microPart = BigInt(fracPart.padEnd(6, '0'));
  const limitMicroUsd = wholeUsd * MICRO_USD_PER_USD + microPart;
  if (limitMicroUsd > BigInt(MAX_AI_MONTHLY_BUDGET_USD) * MICRO_USD_PER_USD) {
    return { ok: false, code: 'INVALID_MONTHLY_BUDGET' };
  }

  return { ok: true, limitMicroUsd };
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value);
}

/**
 * Atomically reserves `ceilingMicroUsd` against the shared UTC-month budget.
 * Uses PostgreSQL row-level serialization in `ON CONFLICT DO UPDATE ... WHERE ...` so concurrent
 * requests can never push `spentMicroUsd + reservedMicroUsd` past `limitMicroUsd`.
 */
export async function reserveMonthlyAiBudget({
  ceilingMicroUsd,
  now = new Date(),
  db = prisma,
}: {
  ceilingMicroUsd: bigint;
  now?: Date;
  db?: MonthlyBudgetDbClient;
}): Promise<MonthlyBudgetReservation> {
  const monthStart = startOfUtcMonth(now);
  const resetAt = nextUtcMonthStart(now).getTime();

  const parsed = parseMonthlyBudgetMicroUsd();
  if (!parsed.ok) {
    console.error('Monthly AI budget configuration rejected:', {
      code: parsed.code,
      env: AI_MONTHLY_BUDGET_USD_ENV,
    });
    return { allowed: false, reason: 'invalid_config', resetAt };
  }

  const { limitMicroUsd } = parsed;
  if (ceilingMicroUsd < BigInt(0)) {
    return { allowed: false, reason: 'invalid_config', resetAt };
  }
  if (limitMicroUsd <= BigInt(0) || ceilingMicroUsd > limitMicroUsd) {
    return { allowed: false, reason: 'exhausted', limitMicroUsd, resetAt };
  }

  const rows = await db.$queryRaw<
    Array<{ reservedMicroUsd: bigint | number | string; spentMicroUsd: bigint | number | string }>
  >`
    INSERT INTO ai_monthly_budgets ("monthStart", "reservedMicroUsd", "spentMicroUsd", "updatedAt")
    VALUES (${monthStart}, ${ceilingMicroUsd}, 0, NOW())
    ON CONFLICT ("monthStart") DO UPDATE
      SET "reservedMicroUsd" = ai_monthly_budgets."reservedMicroUsd" + ${ceilingMicroUsd},
          "updatedAt" = NOW()
      WHERE ai_monthly_budgets."spentMicroUsd" + ai_monthly_budgets."reservedMicroUsd" + ${ceilingMicroUsd} <= ${limitMicroUsd}
    RETURNING "reservedMicroUsd", "spentMicroUsd"`;

  if (rows.length === 0) {
    return { allowed: false, reason: 'exhausted', limitMicroUsd, resetAt };
  }

  return {
    allowed: true,
    monthStart,
    ceilingMicroUsd,
    limitMicroUsd,
    reservedMicroUsd: toBigInt(rows[0].reservedMicroUsd),
    spentMicroUsd: toBigInt(rows[0].spentMicroUsd),
  };
}

/**
 * Releases the previously reserved ceiling on `monthStart` and records `actualMicroUsd` spent.
 * Fails closed: requires exactly one matching row with `"reservedMicroUsd" >= ceilingMicroUsd`
 * (never masking under-reservation with GREATEST) and propagates accounting errors.
 * Never retries an ambiguous DB error: retaining the conservative ceiling in `reservedMicroUsd`
 * prevents undercounting spend if a write outcome is uncertain.
 */
export async function reconcileMonthlyAiBudget({
  monthStart,
  ceilingMicroUsd,
  actualMicroUsd,
  db = prisma,
}: {
  monthStart: Date;
  ceilingMicroUsd: bigint;
  actualMicroUsd: bigint;
  db?: MonthlyBudgetDbClient;
}): Promise<{ reservedMicroUsd: bigint; spentMicroUsd: bigint }> {
  if (ceilingMicroUsd < BigInt(0) || actualMicroUsd < BigInt(0)) {
    console.error('Monthly AI budget reconciliation rejected invalid amount:', {
      reason: 'invalid_settlement_amount',
    });
    throw new MonthlyBudgetAccountingError('invalid_settlement_amount');
  }

  let rows: Array<{
    reservedMicroUsd: bigint | number | string;
    spentMicroUsd: bigint | number | string;
  }>;
  try {
    rows = await db.$queryRaw<
      Array<{ reservedMicroUsd: bigint | number | string; spentMicroUsd: bigint | number | string }>
    >`
      UPDATE ai_monthly_budgets
      SET "reservedMicroUsd" = "reservedMicroUsd" - ${ceilingMicroUsd},
          "spentMicroUsd" = "spentMicroUsd" + ${actualMicroUsd},
          "updatedAt" = NOW()
      WHERE "monthStart" = ${monthStart}
        AND "reservedMicroUsd" >= ${ceilingMicroUsd}
      RETURNING "reservedMicroUsd", "spentMicroUsd"`;
  } catch (error) {
    console.error('Monthly AI budget reconciliation failed:', textAiErrorCode(error));
    throw new MonthlyBudgetAccountingError('reconciliation_db_error');
  }

  if (rows.length !== 1) {
    console.error('Monthly AI budget reconciliation failed:', 'settlement_mismatch');
    throw new MonthlyBudgetAccountingError('settlement_mismatch');
  }

  return {
    reservedMicroUsd: toBigInt(rows[0].reservedMicroUsd),
    spentMicroUsd: toBigInt(rows[0].spentMicroUsd),
  };
}
