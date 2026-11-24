import { AsyncLocalStorage } from 'node:async_hooks';
import type { EmojiProvider } from '@/lib/services/emoji-errors';

export type AiQuotaKind = 'text' | 'image';

export type MonthlyReservationHandle = {
  monthStart: Date;
  ceilingMicroUsd: bigint;
};

export type TextReservationBounds = {
  primaryModel: string;
  fallbackModel?: string;
  maxPromptTokens: number;
};

export type ImageReservationBounds = {
  provider: EmojiProvider;
  model: string;
  maxPromptTokens: number;
  maxOutputTokens?: number;
  candidateCount?: number;
  size?: string;
  quality?: string;
  imageSize?: string;
  aspectRatio?: string;
  outputCount: number;
};

export type AiQuotaContext = {
  kind: AiQuotaKind;
  ceilingMicroUsd?: bigint;
  textBounds?: TextReservationBounds;
  imageBounds?: ImageReservationBounds;
  monthlyReservation: MonthlyReservationHandle | null;
};

const quotaContextStorage = new AsyncLocalStorage<AiQuotaContext>();

export function runWithAiQuotaContext<T>(
  options: {
    kind: AiQuotaKind;
    ceilingMicroUsd?: bigint;
    textBounds?: TextReservationBounds;
    imageBounds?: ImageReservationBounds;
  },
  fn: () => Promise<T>
): { context: AiQuotaContext; promise: Promise<T> } {
  const context: AiQuotaContext = {
    kind: options.kind,
    ceilingMicroUsd: options.ceilingMicroUsd,
    textBounds: options.textBounds,
    imageBounds: options.imageBounds,
    monthlyReservation: null,
  };
  const promise = quotaContextStorage.run(context, fn);
  return { context, promise };
}

export function getActiveAiQuotaContext(): AiQuotaContext | undefined {
  return quotaContextStorage.getStore();
}
