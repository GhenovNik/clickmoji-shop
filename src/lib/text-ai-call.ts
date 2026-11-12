import { NextResponse } from 'next/server';
import type { Locale } from '@/i18n/config';
import { enforceAiQuota } from '@/lib/ai-quota';
import { getServerTranslator } from '@/lib/auth-security';
import { prisma } from '@/lib/prisma';
import { GoogleTextUnavailableError, textAiErrorCode } from '@/lib/services/text-ai-errors';

/** One reservation for one logical text operation, including service retries/fallback and parsing.
 * Only a failed operation is compensated; callers persist successful results outside this scope.
 * No transaction is held during network I/O and no reusable refund capability escapes this helper.
 */
export async function runTextAiCall<T>(
  user: { id: string; role: string | null | undefined },
  locale: Locale,
  operation: () => Promise<T>
): Promise<T | Response> {
  // Freeze both the owner and UTC window before acquisition, not after the network call.
  const reservationUser = { id: user.id, role: user.role };
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const denied = await enforceAiQuota(reservationUser, locale, now);
  if (denied) return denied;

  try {
    return await operation();
  } catch (error) {
    // Exactly one atomic compensation for this captured reservation. Never retry an ambiguous
    // database result: retaining a unit is safer than accidentally refunding another operation.
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
  }
}
