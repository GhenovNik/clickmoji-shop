import { NextResponse } from 'next/server';
import type { Locale } from '@/i18n/config';
import { AI_INPUT_LIMITS, AiInputTooLargeError } from '@/lib/ai-input-validation';
import { enforceAiQuota } from '@/lib/ai-quota';
import { getActiveAiQuotaContext, runWithAiQuotaContext } from '@/lib/ai-quota-context';
import {
  type MonthlyBudgetDbClient,
  reconcileMonthlyAiBudget,
  reserveMonthlyAiBudget,
} from '@/lib/ai-budget';
import {
  calculateTextOperationCostMicroUsd,
  resolveTextCallPricingConfig,
  runWithAiUsageRecorder,
} from '@/lib/ai-pricing';
import { getServerTranslator } from '@/lib/auth-security';
import { prisma } from '@/lib/prisma';
import { GoogleTextUnavailableError, textAiErrorCode } from '@/lib/services/text-ai-errors';

export type TextAiCallOptions = {
  prompt?: string;
  maxPromptTokens?: number;
};

export class MonthlyBudgetBlockedError extends Error {
  readonly code: 'MONTHLY_BUDGET_EXHAUSTED' | 'MONTHLY_BUDGET_UNAVAILABLE';
  readonly reason: 'exhausted' | 'invalid_config' | 'db_error';

  constructor(reason: 'exhausted' | 'invalid_config' | 'db_error') {
    const code = reason === 'exhausted' ? 'MONTHLY_BUDGET_EXHAUSTED' : 'MONTHLY_BUDGET_UNAVAILABLE';
    super(`Paid AI blocked by shared monthly budget (${reason})`);
    this.name = 'MonthlyBudgetBlockedError';
    this.code = code;
    this.reason = reason;
  }
}

/** One reservation for one logical text operation, including service retries/fallback and parsing.
 * Also reserves a conservative monthly monetary ceiling and reconciles actual usage (or conservative
 * estimates) after the call settles. Only a failed operation compensates the daily unit.
 * No transaction is held during network I/O and no reusable refund capability escapes this helper.
 * Accounting failures propagate so missing/mismatched settlements never appear successful.
 */
export async function runTextAiCall<T>(
  user: { id: string; role: string | null | undefined },
  locale: Locale,
  operation: () => Promise<T>,
  options?: TextAiCallOptions
): Promise<T | Response> {
  // Freeze both the owner and UTC windows before acquisition, not after the network call.
  const reservationUser = { id: user.id, role: user.role };
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const pricing = resolveTextCallPricingConfig({
    prompt: options?.prompt,
    maxPromptTokens: options?.maxPromptTokens,
  });

  const { promise } = runWithAiQuotaContext(
    {
      kind: 'text',
      ceilingMicroUsd: pricing.ceilingMicroUsd,
      textBounds: {
        primaryModel: pricing.primaryModel,
        fallbackModel: pricing.fallbackModel,
        maxPromptTokens: pricing.maxPromptTokens,
      },
    },
    async () => {
      const denied = await enforceAiQuota(reservationUser, locale, now);
      if (denied) return denied;

      const ctx = getActiveAiQuotaContext();
      const monthlyReservation = ctx?.monthlyReservation ?? null;
      const { recorder, promise: opPromise } = runWithAiUsageRecorder(operation);

      let succeeded = false;
      try {
        const result = await opPromise;
        succeeded = true;
        return result;
      } catch (error) {
        // Exactly one atomic compensation for this captured daily reservation. Never retry an
        // ambiguous database result: retaining a unit is safer than accidentally refunding another.
        try {
          await prisma.$executeRaw`
            UPDATE ai_usage_counters
            SET "count" = "count" - 1, "updatedAt" = NOW()
            WHERE "userId" = ${reservationUser.id} AND "windowStart" = ${windowStart} AND "count" > 0`;
        } catch (refundError) {
          console.error('Text AI quota compensation failed:', textAiErrorCode(refundError));
        }

        if (error instanceof GoogleTextUnavailableError) {
          const t = getServerTranslator(locale);
          return NextResponse.json(
            { error: t('api.aiText.unavailable') },
            { status: 503, headers: { 'Retry-After': '60' } }
          );
        }
        throw error;
      } finally {
        if (monthlyReservation) {
          const actualMicroUsd = calculateTextOperationCostMicroUsd({
            attempts: recorder.textAttempts,
            succeeded,
            fallbackModel: pricing.fallbackModel,
            ceilingMicroUsd: monthlyReservation.ceilingMicroUsd,
          });
          await reconcileMonthlyAiBudget({
            monthStart: monthlyReservation.monthStart,
            ceilingMicroUsd: monthlyReservation.ceilingMicroUsd,
            actualMicroUsd,
          });
        }
      }
    }
  );

  return promise;
}

/**
 * Reserves and reconciles the shared PostgreSQL monthly monetary budget for non-HTTP CLI callers
 * (which have no authenticated user for per-user daily quotas) using the exact prompt bounds.
 */
export async function runMonthlyBudgetedTextAiCall<T>(
  {
    prompt,
    maxPromptTokens,
    db = prisma,
    now = new Date(),
  }: {
    prompt: string;
    maxPromptTokens?: number;
    db?: MonthlyBudgetDbClient;
    now?: Date;
  },
  operation: () => Promise<T>
): Promise<T> {
  if (Buffer.byteLength(prompt, 'utf8') > AI_INPUT_LIMITS.MAX_TEXT_PROMPT_BYTES) {
    throw new AiInputTooLargeError('Text AI prompt exceeds maximum UTF-8 byte length');
  }

  const pricing = resolveTextCallPricingConfig({ prompt, maxPromptTokens });

  let reservation: Awaited<ReturnType<typeof reserveMonthlyAiBudget>>;
  try {
    reservation = await reserveMonthlyAiBudget({
      ceilingMicroUsd: pricing.ceilingMicroUsd,
      now,
      db,
    });
  } catch (error) {
    console.error('CLI monthly AI budget reservation failed:', textAiErrorCode(error));
    throw new MonthlyBudgetBlockedError('db_error');
  }

  if (!reservation.allowed) {
    throw new MonthlyBudgetBlockedError(reservation.reason);
  }

  const { promise } = runWithAiQuotaContext(
    {
      kind: 'text',
      ceilingMicroUsd: pricing.ceilingMicroUsd,
      textBounds: {
        primaryModel: pricing.primaryModel,
        fallbackModel: pricing.fallbackModel,
        maxPromptTokens: pricing.maxPromptTokens,
      },
    },
    async () => {
      const { recorder, promise: opPromise } = runWithAiUsageRecorder(operation);
      let succeeded = false;
      try {
        const result = await opPromise;
        succeeded = true;
        return result;
      } finally {
        const actualMicroUsd = calculateTextOperationCostMicroUsd({
          attempts: recorder.textAttempts,
          succeeded,
          fallbackModel: pricing.fallbackModel,
          ceilingMicroUsd: reservation.ceilingMicroUsd,
        });
        await reconcileMonthlyAiBudget({
          monthStart: reservation.monthStart,
          ceilingMicroUsd: reservation.ceilingMicroUsd,
          actualMicroUsd,
          db,
        });
      }
    }
  );

  return promise;
}
