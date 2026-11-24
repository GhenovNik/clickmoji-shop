import type { Locale } from '@/i18n/config';
import { enforceAiQuota } from '@/lib/ai-quota';
import { getActiveAiQuotaContext, runWithAiQuotaContext } from '@/lib/ai-quota-context';
import { reconcileMonthlyAiBudget } from '@/lib/ai-budget';
import {
  calculateImageOperationCostMicroUsd,
  resolveImagePricingConfig,
  runWithAiUsageRecorder,
} from '@/lib/ai-pricing';

export type ImageAiCallOptions = {
  prompt?: string;
  maxPromptTokens?: number;
};

/**
 * Validates active image model bounds, reserves monthly monetary budget and daily image unit before
 * executing an image generation operation, then reconciles monthly spend against actual usage or a
 * conservative estimate. Accounting failures propagate so missing settlements never appear valid.
 * Daily image units remain attempt-based (never refunded on failure) per docs/ai.md.
 */
export async function runImageAiCall<T>(
  user: { id: string; role: string | null | undefined },
  locale: Locale,
  operation: () => Promise<T>,
  options?: ImageAiCallOptions
): Promise<T | Response> {
  const reservationUser = { id: user.id, role: user.role };
  const now = new Date();
  const pricing = resolveImagePricingConfig({
    prompt: options?.prompt,
    maxPromptTokens: options?.maxPromptTokens,
  });

  const { promise } = runWithAiQuotaContext(
    {
      kind: 'image',
      ceilingMicroUsd: pricing.ceilingMicroUsd,
      imageBounds: {
        provider: pricing.provider,
        model: pricing.model,
        maxPromptTokens: pricing.maxPromptTokens,
        size: pricing.size,
        quality: pricing.quality,
        imageSize: pricing.imageSize,
        aspectRatio: pricing.aspectRatio,
        outputCount: pricing.outputCount,
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
      } finally {
        if (monthlyReservation) {
          const actualMicroUsd = calculateImageOperationCostMicroUsd({
            attempts: recorder.imageAttempts,
            succeeded,
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
