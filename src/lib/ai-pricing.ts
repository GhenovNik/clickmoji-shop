import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DEFAULT_GOOGLE_TEXT_MODEL,
  resolveGoogleTextModel,
  resolveGoogleTextModelFallback,
} from '@/lib/services/google-text-model';
import type { EmojiProvider } from '@/lib/services/emoji-errors';

export const ZERO_MICRO_USD = BigInt(0);
export const MICRO_USD_PER_USD = BigInt(1_000_000);
export const MAX_TEXT_ATTEMPTS = 3;
export const MAX_TEXT_OUTPUT_TOKENS = 4_096;
export const DEFAULT_TEXT_PROMPT_TOKEN_BOUND = 15_000;

type TokenRatesPerMillionUsd = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

// Conservative per-1M-token rates for the reviewed Gemini text allowlist.
const TEXT_MODEL_RATES: Record<string, TokenRatesPerMillionUsd> = {
  'gemini-3.8-flash': { inputUsdPerMillion: 0.5, outputUsdPerMillion: 3.0 },
  'gemini-3.5-flash-lite': { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 },
  'gemini-2.5-flash': { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 },
};

const DEFAULT_TEXT_RATE: TokenRatesPerMillionUsd = TEXT_MODEL_RATES[DEFAULT_GOOGLE_TEXT_MODEL];

// Image pricing aligned with docs/ai.md (2026-10-04 official snapshot).
const GEMINI_LITE_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3.1-flash-image';

export type GoogleUsageMetadataLike = {
  promptTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  thoughtsTokenCount?: unknown;
  toolUsePromptTokenCount?: unknown;
  totalTokenCount?: unknown;
};

export type OpenAIImageUsageLike = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  input_tokens_details?: {
    text_tokens?: unknown;
    image_tokens?: unknown;
  };
  output_tokens_details?: {
    text_tokens?: unknown;
    image_tokens?: unknown;
  };
};

export type AttemptOutcome = 'ok' | 'rejected' | 'timeout' | 'error';

export type RecordedTextAttempt = {
  model: string;
  promptChars: number;
  outcome: AttemptOutcome;
  usageMetadata?: GoogleUsageMetadataLike;
};

export type RecordedImageAttempt = {
  provider: EmojiProvider;
  model: string;
  promptChars: number;
  outcome: AttemptOutcome;
  googleUsageMetadata?: GoogleUsageMetadataLike;
  openaiUsage?: OpenAIImageUsageLike;
};

export type AiUsageRecorder = {
  textAttempts: RecordedTextAttempt[];
  imageAttempts: RecordedImageAttempt[];
};

const usageRecorderStorage = new AsyncLocalStorage<AiUsageRecorder>();

export function runWithAiUsageRecorder<T>(fn: () => Promise<T>): {
  recorder: AiUsageRecorder;
  promise: Promise<T>;
} {
  const recorder: AiUsageRecorder = { textAttempts: [], imageAttempts: [] };
  const promise = usageRecorderStorage.run(recorder, fn);
  return { recorder, promise };
}

export function recordTextProviderAttempt(attempt: RecordedTextAttempt): void {
  const recorder = usageRecorderStorage.getStore();
  if (recorder) {
    recorder.textAttempts.push(attempt);
  }
}

export function recordImageProviderAttempt(attempt: RecordedImageAttempt): void {
  const recorder = usageRecorderStorage.getStore();
  if (recorder) {
    recorder.imageAttempts.push(attempt);
  }
}

function safeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function usdPerMillionToMicroUsd(tokens: number, usdPerMillion: number): bigint {
  if (tokens <= 0 || usdPerMillion <= 0) return ZERO_MICRO_USD;
  // Since 1 USD = 1_000_000 micro-USD, usdPerMillion equals micro-USD per single token.
  // Round up so positive usage never rounds down to 0 micro-USD.
  return BigInt(Math.ceil(tokens * usdPerMillion));
}

function textRatesForModel(model: string): TokenRatesPerMillionUsd {
  return TEXT_MODEL_RATES[model] ?? DEFAULT_TEXT_RATE;
}

export function estimateTextAttemptCeilingMicroUsd(
  model: string,
  maxPromptTokens = DEFAULT_TEXT_PROMPT_TOKEN_BOUND
): bigint {
  const rates = textRatesForModel(model);
  return (
    usdPerMillionToMicroUsd(maxPromptTokens, rates.inputUsdPerMillion) +
    usdPerMillionToMicroUsd(MAX_TEXT_OUTPUT_TOKENS, rates.outputUsdPerMillion)
  );
}

export function estimateTextCallCeilingMicroUsd(options?: {
  primaryModel?: string;
  fallbackModel?: string;
  maxPromptTokens?: number;
}): bigint {
  const maxPromptTokens = options?.maxPromptTokens ?? DEFAULT_TEXT_PROMPT_TOKEN_BOUND;
  let primary = options?.primaryModel;
  let fallback = options?.fallbackModel;

  if (!primary) {
    try {
      primary = resolveGoogleTextModel();
    } catch {
      primary = DEFAULT_GOOGLE_TEXT_MODEL;
    }
  }
  if (!fallback) {
    try {
      fallback = resolveGoogleTextModelFallback();
    } catch {
      fallback = primary;
    }
  }

  const primaryCeiling = estimateTextAttemptCeilingMicroUsd(primary, maxPromptTokens);
  const finalCeiling = estimateTextAttemptCeilingMicroUsd(fallback ?? primary, maxPromptTokens);
  // Up to 2 attempts on primary + 1 attempt on fallback (or primary when fallback is unset).
  return primaryCeiling * BigInt(2) + finalCeiling;
}

export function calculateTextAttemptCostMicroUsd(attempt: RecordedTextAttempt): bigint {
  if (attempt.outcome === 'rejected') {
    return ZERO_MICRO_USD;
  }

  const rates = textRatesForModel(attempt.model);
  const meta = attempt.usageMetadata;

  if (meta && typeof meta === 'object') {
    const promptTokens = safeNonNegativeInt(meta.promptTokenCount);
    const toolTokens = safeNonNegativeInt(meta.toolUsePromptTokenCount) ?? 0;
    const candidatesTokens = safeNonNegativeInt(meta.candidatesTokenCount);
    const thoughtsTokens = safeNonNegativeInt(meta.thoughtsTokenCount) ?? 0;
    const totalTokens = safeNonNegativeInt(meta.totalTokenCount);

    if (promptTokens !== undefined || candidatesTokens !== undefined) {
      const inputTokens = (promptTokens ?? Math.ceil(attempt.promptChars / 2)) + toolTokens;
      const outputTokens =
        (candidatesTokens ?? (attempt.outcome === 'ok' ? 1024 : MAX_TEXT_OUTPUT_TOKENS)) +
        thoughtsTokens;
      return (
        usdPerMillionToMicroUsd(inputTokens, rates.inputUsdPerMillion) +
        usdPerMillionToMicroUsd(outputTokens, rates.outputUsdPerMillion)
      );
    }

    if (totalTokens !== undefined) {
      return usdPerMillionToMicroUsd(totalTokens, rates.outputUsdPerMillion);
    }
  }

  // Fallback conservative estimate when the provider response carries no usable usage block.
  const estimatedInputTokens = Math.max(1, Math.ceil(attempt.promptChars / 2));
  const estimatedOutputTokens = attempt.outcome === 'ok' ? 1024 : MAX_TEXT_OUTPUT_TOKENS;
  return (
    usdPerMillionToMicroUsd(estimatedInputTokens, rates.inputUsdPerMillion) +
    usdPerMillionToMicroUsd(estimatedOutputTokens, rates.outputUsdPerMillion)
  );
}

export function calculateTextOperationCostMicroUsd({
  attempts,
  succeeded,
  fallbackModel,
}: {
  attempts: RecordedTextAttempt[];
  succeeded: boolean;
  fallbackModel?: string;
}): bigint {
  if (attempts.length > 0) {
    return attempts.reduce(
      (sum, attempt) => sum + calculateTextAttemptCostMicroUsd(attempt),
      ZERO_MICRO_USD
    );
  }
  // When a service double succeeded without calling generateGoogleText, charge a single
  // conservative estimate so mocked-service tests still exercise accounting reconciliation.
  if (succeeded) {
    const model = fallbackModel ?? DEFAULT_GOOGLE_TEXT_MODEL;
    return calculateTextAttemptCostMicroUsd({
      model,
      promptChars: 2000,
      outcome: 'ok',
    });
  }
  return ZERO_MICRO_USD;
}

function activeImageModelConfig(): { provider: EmojiProvider; model: string } {
  const provider: EmojiProvider = process.env.AI_PROVIDER === 'gpt-image' ? 'gpt-image' : 'gemini';
  if (provider === 'gpt-image') {
    const model = process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-2.5-flare';
    return { provider, model };
  }
  const model =
    process.env.GOOGLE_IMAGE_MODEL?.trim() ||
    process.env.IMAGEN_MODEL?.trim() ||
    GEMINI_LITE_IMAGE_MODEL;
  return { provider, model };
}

export function estimateImageCallCeilingMicroUsd(options?: {
  provider?: EmojiProvider;
  model?: string;
}): bigint {
  const resolved =
    options?.provider && options?.model
      ? { provider: options.provider, model: options.model }
      : activeImageModelConfig();

  if (resolved.provider === 'gpt-image') {
    // OpenAI GPT Image 2.5 medium 1024x1024 conservative upper bound ($0.125).
    return BigInt(125_000);
  }

  if (resolved.model === GEMINI_LITE_IMAGE_MODEL) {
    // $0.0336 base image + prompt/thought token headroom ($0.040).
    return BigInt(40_000);
  }
  if (resolved.model === GEMINI_FLASH_IMAGE_MODEL) {
    // $0.067 base image + prompt/thought token headroom ($0.075).
    return BigInt(75_000);
  }
  // Other Gemini / legacy Imagen models ($0.100).
  return BigInt(100_000);
}

export function calculateImageAttemptCostMicroUsd(attempt: RecordedImageAttempt): bigint {
  if (attempt.outcome === 'rejected') {
    return ZERO_MICRO_USD;
  }

  if (attempt.provider === 'gpt-image') {
    const usage = attempt.openaiUsage;
    if (usage && typeof usage === 'object') {
      const inputTokens = safeNonNegativeInt(usage.input_tokens);
      const outputTokens = safeNonNegativeInt(usage.output_tokens);
      if (inputTokens !== undefined && outputTokens !== undefined) {
        const textIn = safeNonNegativeInt(usage.input_tokens_details?.text_tokens);
        const imageIn = safeNonNegativeInt(usage.input_tokens_details?.image_tokens);
        const inputCost =
          textIn !== undefined || imageIn !== undefined
            ? usdPerMillionToMicroUsd(textIn ?? 0, 5) +
              usdPerMillionToMicroUsd(imageIn ?? Math.max(0, inputTokens - (textIn ?? 0)), 8)
            : usdPerMillionToMicroUsd(inputTokens, 8);

        const textOut = safeNonNegativeInt(usage.output_tokens_details?.text_tokens);
        const imageOut = safeNonNegativeInt(usage.output_tokens_details?.image_tokens);
        const outputCost =
          textOut !== undefined || imageOut !== undefined
            ? usdPerMillionToMicroUsd(textOut ?? 0, 10) +
              usdPerMillionToMicroUsd(imageOut ?? Math.max(0, outputTokens - (textOut ?? 0)), 30)
            : usdPerMillionToMicroUsd(outputTokens, 30);

        return inputCost + outputCost;
      }
    }
    return estimateImageCallCeilingMicroUsd({ provider: attempt.provider, model: attempt.model });
  }

  // Google image branch
  const meta = attempt.googleUsageMetadata;
  const baseImageMicroUsd =
    attempt.model === GEMINI_LITE_IMAGE_MODEL
      ? BigInt(33_600)
      : attempt.model === GEMINI_FLASH_IMAGE_MODEL
        ? BigInt(67_000)
        : BigInt(67_000);
  const outputUsdPerMillion = attempt.model === GEMINI_LITE_IMAGE_MODEL ? 30 : 60;

  if (meta && typeof meta === 'object') {
    const promptTokens = safeNonNegativeInt(meta.promptTokenCount);
    const candidatesTokens = safeNonNegativeInt(meta.candidatesTokenCount);
    const thoughtsTokens = safeNonNegativeInt(meta.thoughtsTokenCount) ?? 0;

    if (promptTokens !== undefined || candidatesTokens !== undefined) {
      const inputCost = usdPerMillionToMicroUsd(
        promptTokens ?? Math.max(1, Math.ceil(attempt.promptChars / 2)),
        0.5
      );
      const outputCost =
        candidatesTokens !== undefined
          ? usdPerMillionToMicroUsd(candidatesTokens + thoughtsTokens, outputUsdPerMillion)
          : baseImageMicroUsd + usdPerMillionToMicroUsd(thoughtsTokens, outputUsdPerMillion);
      const computed = inputCost + outputCost;
      if (attempt.outcome === 'ok' && computed < baseImageMicroUsd) {
        return baseImageMicroUsd + inputCost;
      }
      return computed;
    }
  }

  return estimateImageCallCeilingMicroUsd({ provider: attempt.provider, model: attempt.model });
}

export function calculateImageOperationCostMicroUsd({
  attempts,
  succeeded,
}: {
  attempts: RecordedImageAttempt[];
  succeeded: boolean;
}): bigint {
  if (attempts.length > 0) {
    return attempts.reduce(
      (sum, attempt) => sum + calculateImageAttemptCostMicroUsd(attempt),
      ZERO_MICRO_USD
    );
  }
  if (succeeded) {
    return estimateImageCallCeilingMicroUsd();
  }
  return ZERO_MICRO_USD;
}
