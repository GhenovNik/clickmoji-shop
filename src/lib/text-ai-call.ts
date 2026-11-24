import { NextResponse } from 'next/server';
import type { Locale } from '@/i18n/config';
import { enforceAiQuota } from '@/lib/ai-quota';
import { getActiveAiQuotaContext, runWithAiQuotaContext } from '@/lib/ai-quota-context';
import { reconcileMonthlyAiBudget } from '@/lib/ai-budget';
import {
  calculateTextOperationCostMicroUsd,
  estimateTextCallCeilingMicroUsd,
  runWithAiUsageRecorder,
} from '@/lib/ai-pricing';
import { getServerTranslator } from '@/lib/auth-security';
import { prisma } from '@/lib/prisma';
import { GoogleTextUnavailableError, textAiErrorCode } from '@/lib/services/text-ai-errors';

/** One reservation for one logical text operation, including service retries/fallback and parsing.
 * Also reserves a conservative monthly monetary ceiling and reconciles actual usage (or conservative
 * estimates) after the call settles. Only a failed operation compensates the daily unit.
 * No transaction is held during network I/O and no reusable refund capability escapes this helper.
 */
export async function runTextAiCall<T>(
  user: { id: string; role: string | null | undefined },
  locale: Locale,
  operation: () => Promise<T>
): Promise<T | Response> {
  // Freeze both the owner and UTC windows before acquisition, not after the network call.
  const reservationUser = { id: user.id, role: user.role };
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ceilingMicroUsd = estimateTextCallCeilingMicroUsd();

  const { promise } = runWithAiQuotaContext({ kind: 'text', ceilingMicroUsd }, async () => {
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
        });
        await reconcileMonthlyAiBudget({
          monthStart: monthlyReservation.monthStart,
          ceilingMicroUsd: monthlyReservation.ceilingMicroUsd,
          actualMicroUsd,
        });
      }
    }
  });

  return promise;
}
