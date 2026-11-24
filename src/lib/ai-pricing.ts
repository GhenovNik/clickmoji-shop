import { AsyncLocalStorage } from 'node:async_hooks';
import { AI_INPUT_LIMITS } from '@/lib/ai-input-validation';
import { EmojiImageGenerationError, type EmojiProvider } from '@/lib/services/emoji-errors';
import {
  DEFAULT_GOOGLE_TEXT_MODEL,
  resolveGoogleTextModel,
  resolveGoogleTextModelFallback,
} from '@/lib/services/google-text-model';

export const ZERO_MICRO_USD = BigInt(0);
export const MICRO_USD_PER_USD = BigInt(1_000_000);
export const MAX_TEXT_ATTEMPTS = 3;
export const MAX_TEXT_OUTPUT_TOKENS = 4_096;
export const TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD = 64;
export const IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD = 64;
export const DEFAULT_TEXT_PROMPT_TOKEN_BOUND =
  AI_INPUT_LIMITS.MAX_TEXT_PROMPT_BYTES + TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD;
export const DEFAULT_IMAGE_PROMPT_TOKEN_BOUND =
  AI_INPUT_LIMITS.MAX_IMAGE_PROMPT_BYTES + IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD;

const DEFAULT_GOOGLE_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';
const DEFAULT_OPENAI_IMAGE_SIZE = '1024x1024';
const DEFAULT_OPENAI_IMAGE_QUALITY = 'medium';
const DEFAULT_GOOGLE_ASPECT_RATIO = '1:1';
const DEFAULT_OUTPUT_COUNT = 1;

type TokenRatesPerMillionUsd = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

/**
 * Conservative standard paid-tier rates per 1M tokens (including thinking tokens in output),
 * aligned with https://ai.google.dev/gemini-api/docs/pricing.
 * `gemini-3.8-flash` uses standard post-introductory pricing ($1.50 / $7.50; intro $0.75 / $3.75
 * through 2026-12-31) so reservations never undercount across calendar boundaries.
 */
const TEXT_MODEL_RATES: Record<string, TokenRatesPerMillionUsd> = {
  'gemini-3.8-flash': { inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 },
  'gemini-3.5-flash-lite': { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 },
  'gemini-2.5-flash': { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 },
};

const MAX_TEXT_RATE: TokenRatesPerMillionUsd = {
  inputUsdPerMillion: 1.5,
  outputUsdPerMillion: 7.5,
};

type GoogleGenerateContentImageSpec = {
  provider: 'gemini';
  adapter: 'generateContent';
  inputUsdPerMillion: number;
  textOutputUsdPerMillion: number;
  imageOutputUsdPerMillion: number;
  imageSizeTokens: Record<string, number>;
  defaultImageSize: string;
  supportedAspectRatios: readonly string[];
  maxThoughtTokens: number;
  maxOutputCount: number;
};

type GoogleGenerateImagesSpec = {
  provider: 'gemini';
  adapter: 'generateImages';
  perImageMicroUsd: bigint;
  supportedAspectRatios: readonly string[];
  maxOutputCount: number;
};

type OpenAIImageSpec = {
  provider: 'gpt-image';
  adapter: 'images.generate';
  textInputUsdPerMillion: number;
  imageInputUsdPerMillion: number;
  textOutputUsdPerMillion: number;
  imageOutputUsdPerMillion: number;
  sizeAreaFactor: Record<string, number>;
  qualityOutputTokenBound: Record<string, number>;
  maxOutputCount: number;
};

export type SupportedImageModelSpec =
  GoogleGenerateContentImageSpec | GoogleGenerateImagesSpec | OpenAIImageSpec;

/**
 * Official image model pricing and request bounds registry.
 * Sources: https://ai.google.dev/gemini-api/docs/pricing and
 * https://developers.openai.com/api/docs/pricing (plus docs/ai.md).
 * Models or parameter combinations outside this table have unknown cost bounds and are rejected
 * before budget reservation or SDK construction.
 */
const SUPPORTED_IMAGE_MODEL_SPECS: Record<string, SupportedImageModelSpec> = {
  'gemini-3.1-flash-lite-image': {
    provider: 'gemini',
    adapter: 'generateContent',
    inputUsdPerMillion: 0.25,
    textOutputUsdPerMillion: 1.5,
    imageOutputUsdPerMillion: 30,
    imageSizeTokens: { '1K': 1_120 },
    defaultImageSize: '1K',
    supportedAspectRatios: ['1:1'],
    maxThoughtTokens: 32_768,
    maxOutputCount: 1,
  },
  'gemini-3.1-flash-image': {
    provider: 'gemini',
    adapter: 'generateContent',
    inputUsdPerMillion: 0.5,
    textOutputUsdPerMillion: 3.0,
    imageOutputUsdPerMillion: 60,
    imageSizeTokens: { '0.5K': 747, '1K': 1_120, '2K': 1_680, '4K': 2_520 },
    defaultImageSize: '1K',
    supportedAspectRatios: ['1:1'],
    maxThoughtTokens: 32_768,
    maxOutputCount: 1,
  },
  'gemini-2.5-flash-image': {
    provider: 'gemini',
    adapter: 'generateContent',
    inputUsdPerMillion: 0.3,
    textOutputUsdPerMillion: 2.5,
    imageOutputUsdPerMillion: 30,
    imageSizeTokens: { '1K': 1_290 },
    defaultImageSize: '1K',
    supportedAspectRatios: ['1:1'],
    maxThoughtTokens: 8_192,
    maxOutputCount: 1,
  },
  'gemini-2.5-flash-image-preview': {
    provider: 'gemini',
    adapter: 'generateContent',
    inputUsdPerMillion: 0.3,
    textOutputUsdPerMillion: 2.5,
    imageOutputUsdPerMillion: 30,
    imageSizeTokens: { '1K': 1_290 },
    defaultImageSize: '1K',
    supportedAspectRatios: ['1:1'],
    maxThoughtTokens: 8_192,
    maxOutputCount: 1,
  },
  'gemini-3-pro-image': {
    provider: 'gemini',
    adapter: 'generateContent',
    inputUsdPerMillion: 2.0,
    textOutputUsdPerMillion: 12.0,
    imageOutputUsdPerMillion: 120,
    imageSizeTokens: { '1K': 1_120, '2K': 1_120, '4K': 2_000 },
    defaultImageSize: '1K',
    supportedAspectRatios: ['1:1'],
    maxThoughtTokens: 32_768,
    maxOutputCount: 1,
  },
  'imagen-4.0-generate-001': {
    provider: 'gemini',
    adapter: 'generateImages',
    perImageMicroUsd: BigInt(40_000),
    supportedAspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
    maxOutputCount: 4,
  },
  'imagen-4.0-fast-generate-001': {
    provider: 'gemini',
    adapter: 'generateImages',
    perImageMicroUsd: BigInt(20_000),
    supportedAspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
    maxOutputCount: 4,
  },
  'imagen-4.0-ultra-generate-001': {
    provider: 'gemini',
    adapter: 'generateImages',
    perImageMicroUsd: BigInt(60_000),
    supportedAspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
    maxOutputCount: 4,
  },
  'gpt-image-2.5-flare': {
    provider: 'gpt-image',
    adapter: 'images.generate',
    textInputUsdPerMillion: 5,
    imageInputUsdPerMillion: 8,
    textOutputUsdPerMillion: 10,
    imageOutputUsdPerMillion: 30,
    sizeAreaFactor: { '1024x1024': 1, '1024x1536': 1.5, '1536x1024': 1.5 },
    qualityOutputTokenBound: { low: 1_000, medium: 4_000, high: 8_000, xhigh: 12_000, max: 20_000 },
    maxOutputCount: 10,
  },
  'gpt-image-2.5-sunburst': {
    provider: 'gpt-image',
    adapter: 'images.generate',
    textInputUsdPerMillion: 5,
    imageInputUsdPerMillion: 8,
    textOutputUsdPerMillion: 10,
    imageOutputUsdPerMillion: 30,
    sizeAreaFactor: { '1024x1024': 1, '1024x1536': 1.5, '1536x1024': 1.5 },
    qualityOutputTokenBound: { low: 1_000, medium: 4_000, high: 8_000, xhigh: 12_000, max: 20_000 },
    maxOutputCount: 10,
  },
  'gpt-image-2': {
    provider: 'gpt-image',
    adapter: 'images.generate',
    textInputUsdPerMillion: 5,
    imageInputUsdPerMillion: 8,
    textOutputUsdPerMillion: 10,
    imageOutputUsdPerMillion: 30,
    sizeAreaFactor: { '1024x1024': 1, '1024x1536': 1.5, '1536x1024': 1.5 },
    qualityOutputTokenBound: { low: 1_000, medium: 4_000, high: 8_000 },
    maxOutputCount: 10,
  },
  'gpt-image-1.5': {
    provider: 'gpt-image',
    adapter: 'images.generate',
    textInputUsdPerMillion: 5,
    imageInputUsdPerMillion: 8,
    textOutputUsdPerMillion: 10,
    imageOutputUsdPerMillion: 32,
    sizeAreaFactor: { '1024x1024': 1, '1024x1536': 1.5, '1536x1024': 1.5 },
    qualityOutputTokenBound: { low: 1_000, medium: 4_000, high: 8_000 },
    maxOutputCount: 10,
  },
};

export const SUPPORTED_GOOGLE_IMAGE_MODELS = Object.freeze(
  Object.entries(SUPPORTED_IMAGE_MODEL_SPECS)
    .filter(([, spec]) => spec.provider === 'gemini')
    .map(([model]) => model)
);

export const SUPPORTED_OPENAI_IMAGE_MODELS = Object.freeze(
  Object.entries(SUPPORTED_IMAGE_MODEL_SPECS)
    .filter(([, spec]) => spec.provider === 'gpt-image')
    .map(([model]) => model)
);

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
  promptBytes?: number;
  outcome: AttemptOutcome;
  usageMetadata?: GoogleUsageMetadataLike;
};

export type RecordedImageAttempt = {
  provider: EmojiProvider;
  model: string;
  promptChars: number;
  promptBytes?: number;
  size?: string;
  quality?: string;
  imageSize?: string;
  aspectRatio?: string;
  outputCount?: number;
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

/**
 * Conservative upper bound on tokenizer input tokens for a UTF-8 prompt string.
 * In byte-level BPE / SentencePiece tokenizers, every content token covers >= 1 UTF-8 byte,
 * plus fixed role/turn/MIME framing tokens (bounded by `framingOverhead`).
 */
export function promptTokenUpperBound(
  prompt: string,
  framingOverhead = TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD
): number {
  return Buffer.byteLength(prompt, 'utf8') + framingOverhead;
}

export function promptTokenUpperBoundFromBytes(
  utf8Bytes: number,
  framingOverhead = TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD
): number {
  const safeBytes = Math.max(0, Math.ceil(utf8Bytes));
  return safeBytes + framingOverhead;
}

function attemptInputTokenUpperBound(
  attempt: { promptChars: number; promptBytes?: number },
  framingOverhead: number
): number {
  if (
    attempt.promptBytes !== undefined &&
    Number.isSafeInteger(attempt.promptBytes) &&
    attempt.promptBytes >= 0
  ) {
    return attempt.promptBytes + framingOverhead;
  }
  // Worst-case UTF-8 byte expansion per UTF-16 code unit is 3 bytes (surrogate pairs: 2 units -> 4 bytes <= 6).
  const safeChars = Math.max(0, Math.ceil(attempt.promptChars));
  return safeChars * 3 + framingOverhead;
}

export function estimateSmartProductPromptTokens({
  productName,
  categoryId,
  categories,
}: {
  productName: string;
  categoryId?: string;
  categories: Array<{ name: string; nameEn: string }>;
}): number {
  // Template overhead (~1450 bytes) + per-category line/hint overhead (~120 bytes) + framing.
  const categoryBytes = categories.reduce(
    (sum, category) =>
      sum +
      Buffer.byteLength(category.name, 'utf8') +
      Buffer.byteLength(category.nameEn, 'utf8') +
      120,
    0
  );
  const inputBytes =
    Buffer.byteLength(productName, 'utf8') +
    (categoryId ? Buffer.byteLength(categoryId, 'utf8') : 0) +
    categoryBytes +
    2_500;
  return promptTokenUpperBoundFromBytes(inputBytes, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD);
}

export function estimateBulkProductsPromptTokens({
  productNames,
  categories,
}: {
  productNames: string[];
  categories: Array<{ name: string; nameEn: string }>;
}): number {
  const namesBytes = productNames.reduce(
    (sum, name) => sum + Buffer.byteLength(name, 'utf8') + 16,
    0
  );
  const categoryBytes = categories.reduce(
    (sum, category) =>
      sum +
      Buffer.byteLength(category.name, 'utf8') +
      Buffer.byteLength(category.nameEn, 'utf8') +
      120,
    0
  );
  const inputBytes = namesBytes + categoryBytes + 2_000;
  return promptTokenUpperBoundFromBytes(inputBytes, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD);
}

export function estimateEmojiPromptTokens(productName: string, description?: string): number {
  const inputBytes =
    Buffer.byteLength(productName, 'utf8') +
    (description ? Buffer.byteLength(description, 'utf8') : 0) +
    1_024;
  return promptTokenUpperBoundFromBytes(inputBytes, IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD);
}

function textRatesForModel(model: string): TokenRatesPerMillionUsd {
  return TEXT_MODEL_RATES[model] ?? MAX_TEXT_RATE;
}

function assertSupportedTextModelRate(model: string): TokenRatesPerMillionUsd {
  const rates = TEXT_MODEL_RATES[model];
  if (!rates) {
    throw new Error(`Unsupported text model for pricing: ${model}`);
  }
  return rates;
}

export function resolveTextCallPricingConfig(options?: {
  primaryModel?: string;
  fallbackModel?: string;
  prompt?: string;
  maxPromptTokens?: number;
}): {
  primaryModel: string;
  fallbackModel: string | undefined;
  maxPromptTokens: number;
  ceilingMicroUsd: bigint;
} {
  const primaryModel = options?.primaryModel ?? resolveGoogleTextModel();
  const fallbackModel =
    options?.fallbackModel !== undefined ? options.fallbackModel : resolveGoogleTextModelFallback();

  assertSupportedTextModelRate(primaryModel);
  if (fallbackModel) {
    assertSupportedTextModelRate(fallbackModel);
  }

  const maxPromptTokens =
    options?.prompt !== undefined
      ? promptTokenUpperBound(options.prompt, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD)
      : (options?.maxPromptTokens ?? DEFAULT_TEXT_PROMPT_TOKEN_BOUND);

  if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens < 0) {
    throw new Error('Invalid maxPromptTokens for text pricing');
  }

  const primaryCeiling = estimateTextAttemptCeilingMicroUsd(primaryModel, maxPromptTokens);
  const finalCeiling = estimateTextAttemptCeilingMicroUsd(
    fallbackModel ?? primaryModel,
    maxPromptTokens
  );

  return {
    primaryModel,
    fallbackModel,
    maxPromptTokens,
    ceilingMicroUsd: primaryCeiling * BigInt(2) + finalCeiling,
  };
}

export function estimateTextAttemptCeilingMicroUsd(
  model: string,
  maxPromptTokens = DEFAULT_TEXT_PROMPT_TOKEN_BOUND
): bigint {
  const rates = assertSupportedTextModelRate(model);
  return (
    usdPerMillionToMicroUsd(maxPromptTokens, rates.inputUsdPerMillion) +
    usdPerMillionToMicroUsd(MAX_TEXT_OUTPUT_TOKENS, rates.outputUsdPerMillion)
  );
}

export function estimateTextCallCeilingMicroUsd(options?: {
  primaryModel?: string;
  fallbackModel?: string;
  prompt?: string;
  maxPromptTokens?: number;
}): bigint {
  return resolveTextCallPricingConfig(options).ceilingMicroUsd;
}

export function calculateTextAttemptCostMicroUsd(attempt: RecordedTextAttempt): bigint {
  const rates = textRatesForModel(attempt.model);
  const meta = attempt.usageMetadata;

  const promptTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.promptTokenCount) : undefined;
  const toolTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.toolUsePromptTokenCount) : undefined;
  const candidatesTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.candidatesTokenCount) : undefined;
  const thoughtsTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.thoughtsTokenCount) : undefined;
  const totalTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.totalTokenCount) : undefined;

  if (attempt.outcome === 'rejected') {
    const anyPositive =
      (promptTokens ?? 0) > 0 ||
      (toolTokens ?? 0) > 0 ||
      (candidatesTokens ?? 0) > 0 ||
      (thoughtsTokens ?? 0) > 0 ||
      (totalTokens ?? 0) > 0;
    if (!anyPositive) {
      return ZERO_MICRO_USD;
    }
  }

  const effectivePromptTokens =
    promptTokens ?? attemptInputTokenUpperBound(attempt, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD);
  const inputTokens = effectivePromptTokens + (toolTokens ?? 0);

  // `maxOutputTokens` (4096) caps candidates + thoughts combined when candidatesTokenCount is present;
  // when candidatesTokenCount is missing (partial usage, ok without usage, timeout, ambiguous error),
  // assume the full MAX_TEXT_OUTPUT_TOKENS (plus any reported thoughts if thoughts exceeded it).
  const baseOutputTokens =
    candidatesTokens !== undefined
      ? candidatesTokens + (thoughtsTokens ?? 0)
      : MAX_TEXT_OUTPUT_TOKENS + (thoughtsTokens ?? 0);

  const accountedTokens = inputTokens + baseOutputTokens;
  const residualTokens =
    totalTokens !== undefined && totalTokens > accountedTokens ? totalTokens - accountedTokens : 0;
  const outputTokens = baseOutputTokens + residualTokens;

  return (
    usdPerMillionToMicroUsd(inputTokens, rates.inputUsdPerMillion) +
    usdPerMillionToMicroUsd(outputTokens, rates.outputUsdPerMillion)
  );
}

export function calculateTextOperationCostMicroUsd({
  attempts,
  succeeded,
  fallbackModel,
  ceilingMicroUsd,
}: {
  attempts: RecordedTextAttempt[];
  succeeded: boolean;
  fallbackModel?: string;
  ceilingMicroUsd?: bigint;
}): bigint {
  if (attempts.length > 0) {
    return attempts.reduce(
      (sum, attempt) => sum + calculateTextAttemptCostMicroUsd(attempt),
      ZERO_MICRO_USD
    );
  }
  if (succeeded) {
    if (ceilingMicroUsd !== undefined) {
      return ceilingMicroUsd;
    }
    const model = fallbackModel ?? DEFAULT_GOOGLE_TEXT_MODEL;
    return estimateTextAttemptCeilingMicroUsd(model, DEFAULT_TEXT_PROMPT_TOKEN_BOUND);
  }
  return ZERO_MICRO_USD;
}

function readTrimmedEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function activeImageModelSelection(): {
  provider: EmojiProvider;
  model: string;
  env: string;
} {
  const provider: EmojiProvider = process.env.AI_PROVIDER === 'gpt-image' ? 'gpt-image' : 'gemini';
  if (provider === 'gpt-image') {
    const model = readTrimmedEnv('OPENAI_IMAGE_MODEL') ?? DEFAULT_OPENAI_IMAGE_MODEL;
    return { provider, model, env: 'OPENAI_IMAGE_MODEL' };
  }
  const googleModel = readTrimmedEnv('GOOGLE_IMAGE_MODEL');
  if (googleModel !== undefined) {
    return { provider, model: googleModel, env: 'GOOGLE_IMAGE_MODEL' };
  }
  const imagenModel = readTrimmedEnv('IMAGEN_MODEL');
  if (imagenModel !== undefined) {
    return { provider, model: imagenModel, env: 'IMAGEN_MODEL' };
  }
  return { provider, model: DEFAULT_GOOGLE_IMAGE_MODEL, env: 'GOOGLE_IMAGE_MODEL' };
}

export type ResolvedImagePricingConfig = {
  provider: EmojiProvider;
  model: string;
  env: string;
  spec: SupportedImageModelSpec;
  size?: string;
  quality?: string;
  imageSize?: string;
  aspectRatio?: string;
  outputCount: number;
  maxPromptTokens: number;
  ceilingMicroUsd: bigint;
};

function assertValidOutputCount(outputCount: number, maxOutputCount: number, model: string): void {
  if (!Number.isSafeInteger(outputCount) || outputCount < 1 || outputCount > maxOutputCount) {
    throw new EmojiImageGenerationError(
      'configuration',
      `Invalid image output count ${String(outputCount)} for model "${model}": expected integer between 1 and ${maxOutputCount}`
    );
  }
}

export function resolveImagePricingConfig(options?: {
  provider?: EmojiProvider;
  model?: string;
  env?: string;
  size?: string;
  quality?: string;
  imageSize?: string;
  aspectRatio?: string;
  outputCount?: number;
  prompt?: string;
  maxPromptTokens?: number;
}): ResolvedImagePricingConfig {
  const active =
    options?.provider && options?.model
      ? {
          provider: options.provider,
          model: options.model,
          env:
            options.env ??
            (options.provider === 'gpt-image' ? 'OPENAI_IMAGE_MODEL' : 'GOOGLE_IMAGE_MODEL'),
        }
      : activeImageModelSelection();

  const spec = SUPPORTED_IMAGE_MODEL_SPECS[active.model];
  if (!spec || spec.provider !== active.provider) {
    const allowed =
      active.provider === 'gpt-image'
        ? SUPPORTED_OPENAI_IMAGE_MODELS
        : SUPPORTED_GOOGLE_IMAGE_MODELS;
    throw new EmojiImageGenerationError(
      'configuration',
      `Invalid ${active.env} value "${active.model}": expected a supported ${active.provider} image model with verified pricing (${allowed.join(', ')})`
    );
  }

  const outputCount = options?.outputCount ?? DEFAULT_OUTPUT_COUNT;
  assertValidOutputCount(outputCount, spec.maxOutputCount, active.model);

  const maxPromptTokens =
    options?.prompt !== undefined
      ? promptTokenUpperBound(options.prompt, IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD)
      : (options?.maxPromptTokens ?? DEFAULT_IMAGE_PROMPT_TOKEN_BOUND);

  if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens < 0) {
    throw new EmojiImageGenerationError(
      'configuration',
      `Invalid maxPromptTokens for model "${active.model}"`
    );
  }

  if (spec.adapter === 'images.generate') {
    const size = options?.size ?? DEFAULT_OPENAI_IMAGE_SIZE;
    const quality = options?.quality ?? DEFAULT_OPENAI_IMAGE_QUALITY;
    const areaFactor = spec.sizeAreaFactor[size];
    if (areaFactor === undefined) {
      throw new EmojiImageGenerationError(
        'configuration',
        `Unsupported image size "${size}" for model "${active.model}"`
      );
    }
    const baseOutputTokens = spec.qualityOutputTokenBound[quality];
    if (baseOutputTokens === undefined) {
      throw new EmojiImageGenerationError(
        'configuration',
        `Unsupported image quality "${quality}" for model "${active.model}"`
      );
    }
    const maxOutputTokens = Math.ceil(baseOutputTokens * areaFactor) * outputCount;
    const ceilingMicroUsd =
      usdPerMillionToMicroUsd(maxPromptTokens, spec.textInputUsdPerMillion) +
      usdPerMillionToMicroUsd(maxOutputTokens, spec.imageOutputUsdPerMillion);
    return {
      ...active,
      spec,
      size,
      quality,
      outputCount,
      maxPromptTokens,
      ceilingMicroUsd,
    };
  }

  if (spec.adapter === 'generateImages') {
    const aspectRatio = options?.aspectRatio ?? DEFAULT_GOOGLE_ASPECT_RATIO;
    if (!spec.supportedAspectRatios.includes(aspectRatio)) {
      throw new EmojiImageGenerationError(
        'configuration',
        `Unsupported aspect ratio "${aspectRatio}" for model "${active.model}"`
      );
    }
    return {
      ...active,
      spec,
      aspectRatio,
      outputCount,
      maxPromptTokens,
      ceilingMicroUsd: spec.perImageMicroUsd * BigInt(outputCount),
    };
  }

  // Google generateContent image model
  const imageSize = options?.imageSize ?? spec.defaultImageSize;
  const aspectRatio = options?.aspectRatio ?? DEFAULT_GOOGLE_ASPECT_RATIO;
  const tokensPerImage = spec.imageSizeTokens[imageSize];
  if (tokensPerImage === undefined) {
    throw new EmojiImageGenerationError(
      'configuration',
      `Unsupported imageSize "${imageSize}" for model "${active.model}"`
    );
  }
  if (!spec.supportedAspectRatios.includes(aspectRatio)) {
    throw new EmojiImageGenerationError(
      'configuration',
      `Unsupported aspect ratio "${aspectRatio}" for model "${active.model}"`
    );
  }

  const ceilingMicroUsd =
    usdPerMillionToMicroUsd(maxPromptTokens, spec.inputUsdPerMillion) +
    usdPerMillionToMicroUsd(tokensPerImage * outputCount, spec.imageOutputUsdPerMillion) +
    usdPerMillionToMicroUsd(spec.maxThoughtTokens, spec.textOutputUsdPerMillion);

  return {
    ...active,
    spec,
    imageSize,
    aspectRatio,
    outputCount,
    maxPromptTokens,
    ceilingMicroUsd,
  };
}

export function estimateImageCallCeilingMicroUsd(options?: {
  provider?: EmojiProvider;
  model?: string;
  size?: string;
  quality?: string;
  imageSize?: string;
  aspectRatio?: string;
  outputCount?: number;
  prompt?: string;
  maxPromptTokens?: number;
}): bigint {
  return resolveImagePricingConfig(options).ceilingMicroUsd;
}

export function calculateImageAttemptCostMicroUsd(attempt: RecordedImageAttempt): bigint {
  const config = resolveImagePricingConfig({
    provider: attempt.provider,
    model: attempt.model,
    size: attempt.size,
    quality: attempt.quality,
    imageSize: attempt.imageSize,
    aspectRatio: attempt.aspectRatio,
    outputCount: attempt.outputCount,
    maxPromptTokens: attemptInputTokenUpperBound(attempt, IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD),
  });

  if (config.spec.adapter === 'images.generate') {
    const spec = config.spec;
    const usage = attempt.openaiUsage;
    const inputTokens =
      usage && typeof usage === 'object' ? safeNonNegativeInt(usage.input_tokens) : undefined;
    const outputTokens =
      usage && typeof usage === 'object' ? safeNonNegativeInt(usage.output_tokens) : undefined;
    const totalTokens =
      usage && typeof usage === 'object' ? safeNonNegativeInt(usage.total_tokens) : undefined;

    if (attempt.outcome === 'rejected') {
      const anyPositive =
        (inputTokens ?? 0) > 0 || (outputTokens ?? 0) > 0 || (totalTokens ?? 0) > 0;
      if (!anyPositive) return ZERO_MICRO_USD;
    }

    const fallbackInputTokens = attemptInputTokenUpperBound(
      attempt,
      IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD
    );
    const areaFactor = spec.sizeAreaFactor[config.size ?? DEFAULT_OPENAI_IMAGE_SIZE] ?? 1;
    const baseQualityBound =
      spec.qualityOutputTokenBound[config.quality ?? DEFAULT_OPENAI_IMAGE_QUALITY] ?? 4_000;
    const fallbackOutputTokens = Math.ceil(baseQualityBound * areaFactor) * config.outputCount;

    let inputCost: bigint;
    let effectiveInputTokens: number;
    if (inputTokens !== undefined && usage && typeof usage === 'object') {
      effectiveInputTokens = inputTokens;
      const textIn = safeNonNegativeInt(usage.input_tokens_details?.text_tokens);
      const imageIn = safeNonNegativeInt(usage.input_tokens_details?.image_tokens);
      if (textIn !== undefined || imageIn !== undefined) {
        const knownText = textIn ?? 0;
        const knownImage = imageIn ?? 0;
        const remainder = Math.max(0, inputTokens - knownText - knownImage);
        inputCost =
          usdPerMillionToMicroUsd(knownText, spec.textInputUsdPerMillion) +
          usdPerMillionToMicroUsd(knownImage + remainder, spec.imageInputUsdPerMillion);
      } else {
        inputCost = usdPerMillionToMicroUsd(inputTokens, spec.imageInputUsdPerMillion);
      }
    } else {
      effectiveInputTokens = fallbackInputTokens;
      inputCost = usdPerMillionToMicroUsd(fallbackInputTokens, spec.textInputUsdPerMillion);
    }

    let outputCost: bigint;
    let effectiveOutputTokens: number;
    if (outputTokens !== undefined && usage && typeof usage === 'object') {
      effectiveOutputTokens = outputTokens;
      const textOut = safeNonNegativeInt(usage.output_tokens_details?.text_tokens);
      const imageOut = safeNonNegativeInt(usage.output_tokens_details?.image_tokens);
      if (textOut !== undefined || imageOut !== undefined) {
        const knownText = textOut ?? 0;
        const knownImage = imageOut ?? 0;
        const remainder = Math.max(0, outputTokens - knownText - knownImage);
        outputCost =
          usdPerMillionToMicroUsd(knownText, spec.textOutputUsdPerMillion) +
          usdPerMillionToMicroUsd(knownImage + remainder, spec.imageOutputUsdPerMillion);
      } else {
        outputCost = usdPerMillionToMicroUsd(outputTokens, spec.imageOutputUsdPerMillion);
      }
    } else {
      effectiveOutputTokens = fallbackOutputTokens;
      outputCost = usdPerMillionToMicroUsd(fallbackOutputTokens, spec.imageOutputUsdPerMillion);
    }

    const accounted = effectiveInputTokens + effectiveOutputTokens;
    const residual =
      totalTokens !== undefined && totalTokens > accounted ? totalTokens - accounted : 0;
    const residualCost = usdPerMillionToMicroUsd(residual, spec.imageOutputUsdPerMillion);

    return inputCost + outputCost + residualCost;
  }

  if (config.spec.adapter === 'generateImages') {
    if (attempt.outcome === 'rejected') {
      return ZERO_MICRO_USD;
    }
    return config.spec.perImageMicroUsd * BigInt(config.outputCount);
  }

  // Google generateContent image model
  const spec = config.spec;
  const meta = attempt.googleUsageMetadata;
  const promptTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.promptTokenCount) : undefined;
  const toolTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.toolUsePromptTokenCount) : undefined;
  const candidatesTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.candidatesTokenCount) : undefined;
  const thoughtsTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.thoughtsTokenCount) : undefined;
  const totalTokens =
    meta && typeof meta === 'object' ? safeNonNegativeInt(meta.totalTokenCount) : undefined;

  if (attempt.outcome === 'rejected') {
    const anyPositive =
      (promptTokens ?? 0) > 0 ||
      (toolTokens ?? 0) > 0 ||
      (candidatesTokens ?? 0) > 0 ||
      (thoughtsTokens ?? 0) > 0 ||
      (totalTokens ?? 0) > 0;
    if (!anyPositive) return ZERO_MICRO_USD;
  }

  const tokensPerImage =
    spec.imageSizeTokens[config.imageSize ?? spec.defaultImageSize] ??
    spec.imageSizeTokens[spec.defaultImageSize];
  const fallbackImageTokens = tokensPerImage * config.outputCount;

  const effectivePromptTokens =
    promptTokens ?? attemptInputTokenUpperBound(attempt, IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD);
  const effectiveInputTokens = effectivePromptTokens + (toolTokens ?? 0);

  const effectiveCandidatesTokens = candidatesTokens ?? fallbackImageTokens;
  const effectiveThoughtsTokens =
    thoughtsTokens !== undefined
      ? thoughtsTokens
      : attempt.outcome === 'ok' && candidatesTokens !== undefined
        ? 0
        : spec.maxThoughtTokens;

  const accounted = effectiveInputTokens + effectiveCandidatesTokens + effectiveThoughtsTokens;
  const residual =
    totalTokens !== undefined && totalTokens > accounted ? totalTokens - accounted : 0;

  return (
    usdPerMillionToMicroUsd(effectiveInputTokens, spec.inputUsdPerMillion) +
    usdPerMillionToMicroUsd(effectiveCandidatesTokens + residual, spec.imageOutputUsdPerMillion) +
    usdPerMillionToMicroUsd(effectiveThoughtsTokens, spec.textOutputUsdPerMillion)
  );
}

export function calculateImageOperationCostMicroUsd({
  attempts,
  succeeded,
  ceilingMicroUsd,
}: {
  attempts: RecordedImageAttempt[];
  succeeded: boolean;
  ceilingMicroUsd?: bigint;
}): bigint {
  if (attempts.length > 0) {
    return attempts.reduce(
      (sum, attempt) => sum + calculateImageAttemptCostMicroUsd(attempt),
      ZERO_MICRO_USD
    );
  }
  if (succeeded) {
    return ceilingMicroUsd ?? estimateImageCallCeilingMicroUsd();
  }
  return ZERO_MICRO_USD;
}
