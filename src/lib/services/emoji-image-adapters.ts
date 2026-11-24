import { GoogleGenAI } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';
import OpenAI from 'openai';
import { AI_INPUT_LIMITS, AiInputTooLargeError } from '@/lib/ai-input-validation';
import {
  DEFAULT_GOOGLE_IMAGE_MODEL,
  IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD,
  promptTokenUpperBound,
  recordImageProviderAttempt,
  resolveImagePricingConfig,
  type ResolvedImagePricingConfig,
} from '@/lib/ai-pricing';
import { getActiveAiQuotaContext } from '@/lib/ai-quota-context';
import {
  classifyProviderFailure,
  EmojiImageGenerationError,
  EmojiProviderUnavailableError,
  type EmojiProvider,
} from '@/lib/services/emoji-errors';
import {
  EMOJI_GENERATION_PROMPT_VERSION,
  EMOJI_GENERATION_TRANSPARENT_PROMPT_VERSION,
  getEmojiGenerationPrompt,
  type EmojiGenerationPromptVersion,
} from '@/lib/prompts/emoji-generation';

export const GOOGLE_IMAGE_MODEL_ENV = 'GOOGLE_IMAGE_MODEL';
export const IMAGEN_MODEL_ENV = 'IMAGEN_MODEL';
export const OPENAI_IMAGE_MODEL_ENV = 'OPENAI_IMAGE_MODEL';

export { DEFAULT_GOOGLE_IMAGE_MODEL };
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const GOOGLE_IMAGE_ASPECT_RATIO = '1:1';
const IMAGE_OUTPUT_COUNT = 1;
const OPENAI_IMAGE_SIZE = '1024x1024';
const OPENAI_IMAGE_QUALITY = 'medium';
const OPENAI_IMAGE_BACKGROUND = 'transparent';

// Values verified against the installed @google/genai FinishReason enum.
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

type GenerateImageInput = {
  productName: string;
  description?: string;
  apiKey: string;
};

type GenerateImageWithModelInput = GenerateImageInput & {
  model: string;
  pricing: ResolvedImagePricingConfig;
};

type GeneratedImage = {
  imageBuffer: Buffer;
  model: string;
  prompt: string;
  promptVersion: EmojiGenerationPromptVersion;
};

export type GoogleImageClient = Pick<GoogleGenAI, 'models'>;
export type OpenAIImageClient = Pick<OpenAI, 'images'>;

/**
 * SDK clients are injectable so callers outside a request (the AGE-347 paid probe) can own
 * transport options such as retries and timeouts without changing the request contract.
 */
export type EmojiImageClientFactory = {
  createGoogleClient?: (options: { apiKey: string }) => GoogleImageClient;
  createOpenAIClient?: (options: { apiKey: string }) => OpenAIImageClient;
};

type ResolvedClientFactory = Required<EmojiImageClientFactory>;

const DEFAULT_CLIENT_FACTORY: ResolvedClientFactory = {
  createGoogleClient: ({ apiKey }) => new GoogleGenAI({ apiKey }),
  // Disable OpenAI SDK implicit retries (default maxRetries=2) so one reservation = at most one HTTP call.
  createOpenAIClient: ({ apiKey }) => new OpenAI({ apiKey, maxRetries: 0 }),
};

function resolveClientFactory(factory?: EmojiImageClientFactory): ResolvedClientFactory {
  return {
    createGoogleClient: factory?.createGoogleClient ?? DEFAULT_CLIENT_FACTORY.createGoogleClient,
    createOpenAIClient: factory?.createOpenAIClient ?? DEFAULT_CLIENT_FACTORY.createOpenAIClient,
  };
}

/**
 * FR-9: no client is created for a key that is unset, empty or whitespace only. The value itself is
 * passed to the SDK unchanged.
 */
function requireProviderApiKey({
  apiKey,
  provider,
  model,
}: {
  apiKey: string;
  provider: EmojiProvider;
  model: string;
}) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new EmojiProviderUnavailableError({ reason: 'missing-key', provider, model });
  }
}

function assertPromptAndContextBounds({
  prompt,
  provider,
  model,
  size,
  quality,
  imageSize,
  aspectRatio,
  outputCount,
  maxOutputTokens,
  candidateCount,
}: {
  prompt: string;
  provider: EmojiProvider;
  model: string;
  size?: string;
  quality?: string;
  imageSize?: string;
  aspectRatio?: string;
  outputCount: number;
  maxOutputTokens?: number;
  candidateCount?: number;
}): number {
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (
    prompt.length > AI_INPUT_LIMITS.MAX_IMAGE_PROMPT_CHARS ||
    promptBytes > AI_INPUT_LIMITS.MAX_IMAGE_PROMPT_BYTES
  ) {
    throw new AiInputTooLargeError('Image AI prompt exceeds maximum length');
  }

  const quotaCtx = getActiveAiQuotaContext();
  if (quotaCtx?.kind === 'image' && quotaCtx.imageBounds) {
    const promptTokens = promptTokenUpperBound(prompt, IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD);
    if (promptTokens > quotaCtx.imageBounds.maxPromptTokens) {
      throw new AiInputTooLargeError('Image AI prompt exceeds reserved monthly budget bound');
    }
    if (
      quotaCtx.imageBounds.provider !== provider ||
      quotaCtx.imageBounds.model !== model ||
      quotaCtx.imageBounds.size !== size ||
      quotaCtx.imageBounds.quality !== quality ||
      quotaCtx.imageBounds.imageSize !== imageSize ||
      quotaCtx.imageBounds.aspectRatio !== aspectRatio ||
      quotaCtx.imageBounds.outputCount !== outputCount ||
      quotaCtx.imageBounds.maxOutputTokens !== maxOutputTokens ||
      quotaCtx.imageBounds.candidateCount !== candidateCount
    ) {
      throw new EmojiImageGenerationError(
        'configuration',
        `Image provider configuration (${provider}/${model}) does not match reserved budget bounds`
      );
    }
  }

  return promptBytes;
}

/**
 * FR-9 + FR-6: one SDK call per generation, no retry of our own. A quota or auth failure becomes a
 * typed `EmojiProviderUnavailableError`; every other SDK failure is rethrown unchanged, and the SDK
 * error itself is not attached to the typed error so it cannot reach a server log.
 */
async function callProviderSdk<T>(
  attemptMeta: {
    provider: EmojiProvider;
    model: string;
    promptChars: number;
    promptBytes: number;
    size?: string;
    quality?: string;
    imageSize?: string;
    aspectRatio?: string;
    outputCount: number;
  },
  operation: () => Promise<T>,
  extractUsage?: (result: T) => {
    googleUsageMetadata?: GenerateContentResponse['usageMetadata'];
    openaiUsage?: OpenAI.Images.ImagesResponse['usage'];
    outputCount?: number;
    finalImagePartsCount?: number;
  }
): Promise<T> {
  try {
    const result = await operation();
    recordImageProviderAttempt({
      ...attemptMeta,
      outcome: 'ok',
      ...extractUsage?.(result),
    });
    return result;
  } catch (error) {
    const reason = classifyProviderFailure(error);
    recordImageProviderAttempt({
      ...attemptMeta,
      outcome: reason ? 'rejected' : 'error',
    });
    if (reason) {
      throw new EmojiProviderUnavailableError({
        reason,
        provider: attemptMeta.provider,
        model: attemptMeta.model,
      });
    }
    throw error;
  }
}

function readModelEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * FR-1: the first non-empty trimmed value wins, `IMAGEN_MODEL` is the deprecated synonym of
 * `GOOGLE_IMAGE_MODEL`, and without either variable the operator default applies. The name of the
 * variable that supplied the value is returned too, so a configuration error names it.
 */
function readGoogleImageModel(): { env: string; model: string } {
  for (const env of [GOOGLE_IMAGE_MODEL_ENV, IMAGEN_MODEL_ENV]) {
    const model = readModelEnv(env);
    if (model !== undefined) {
      return { env, model };
    }
  }
  return { env: GOOGLE_IMAGE_MODEL_ENV, model: DEFAULT_GOOGLE_IMAGE_MODEL };
}

function classifyFinishReason(finishReason: string | undefined) {
  if (finishReason === undefined || finishReason === 'STOP') {
    return;
  }
  if (BLOCKED_FINISH_REASONS.has(finishReason)) {
    throw new EmojiImageGenerationError(
      'blocked',
      `Emoji image generation blocked (finishReason=${finishReason})`
    );
  }
  throw new EmojiImageGenerationError(
    'incomplete',
    `Emoji image generation incomplete (finishReason=${finishReason})`
  );
}

function readBlockedPromptReason(response: GenerateContentResponse) {
  const blockReason = response?.promptFeedback?.blockReason;
  return blockReason ? String(blockReason) : 'none';
}

function assertUsablePngBytes(imageBuffer: Buffer) {
  if (imageBuffer.length === 0) {
    throw new EmojiImageGenerationError(
      'empty-image',
      'Emoji image generation empty-image: image data decoded to zero bytes'
    );
  }
  if (!imageBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new EmojiImageGenerationError(
      'invalid-png',
      'Emoji image generation invalid-png: image data is not a PNG'
    );
  }
  if (imageBuffer.length > MAX_IMAGE_BYTES) {
    throw new EmojiImageGenerationError(
      'too-large',
      `Emoji image generation too-large: image exceeds ${MAX_IMAGE_BYTES} bytes`
    );
  }
}

function readGenerateContentImage(response: GenerateContentResponse): Buffer {
  const candidates = response?.candidates;
  if (!candidates?.length) {
    throw new EmojiImageGenerationError(
      'blocked-prompt',
      `Emoji image generation blocked-prompt (blockReason=${readBlockedPromptReason(response)})`
    );
  }

  const candidate = candidates[0];
  classifyFinishReason(candidate?.finishReason as string | undefined);

  const parts = candidate?.content?.parts ?? [];
  const finalImageParts = parts.filter((part) => part?.inlineData && part.thought !== true);
  const firstImagePart = finalImageParts[0];
  if (!firstImagePart) {
    throw new EmojiImageGenerationError(
      'no-image',
      'Emoji image generation no-image: response has no final image part'
    );
  }

  const inlineData = firstImagePart.inlineData;
  if (inlineData?.mimeType !== 'image/png') {
    throw new EmojiImageGenerationError(
      'unsupported-format',
      'Emoji image generation unsupported-format: expected an image/png part'
    );
  }

  const data = inlineData.data;
  if (!data) {
    throw new EmojiImageGenerationError(
      'empty-image',
      'Emoji image generation empty-image: response part carries no image data'
    );
  }

  const imageBuffer = Buffer.from(data, 'base64');
  assertUsablePngBytes(imageBuffer);

  return imageBuffer;
}

async function generateWithGoogleGenerateContent({
  productName,
  description,
  apiKey,
  model,
  pricing,
  clients,
}: GenerateImageWithModelInput & { clients: ResolvedClientFactory }): Promise<GeneratedImage> {
  requireProviderApiKey({ apiKey, provider: 'gemini', model });
  const prompt = getEmojiGenerationPrompt(productName, description);
  const promptBytes = assertPromptAndContextBounds({
    prompt,
    provider: 'gemini',
    model,
    imageSize: pricing.imageSize,
    aspectRatio: pricing.aspectRatio,
    outputCount: pricing.outputCount,
    maxOutputTokens: pricing.maxOutputTokens,
    candidateCount: pricing.candidateCount,
  });
  const ai = clients.createGoogleClient({ apiKey });

  const response = await callProviderSdk(
    {
      provider: 'gemini',
      model,
      promptChars: prompt.length,
      promptBytes,
      imageSize: pricing.imageSize,
      aspectRatio: pricing.aspectRatio,
      outputCount: pricing.outputCount,
    },
    () =>
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          candidateCount: pricing.candidateCount,
          responseModalities: ['IMAGE'],
          maxOutputTokens: pricing.maxOutputTokens,
          imageConfig: { aspectRatio: GOOGLE_IMAGE_ASPECT_RATIO },
        },
      }),
    (res) => {
      const parts = res?.candidates?.[0]?.content?.parts ?? [];
      const finalImagePartsCount = parts.filter(
        (part) => part?.inlineData && part.thought !== true
      ).length;
      return {
        googleUsageMetadata: res?.usageMetadata,
        finalImagePartsCount,
      };
    }
  );

  return {
    imageBuffer: readGenerateContentImage(response),
    model,
    prompt,
    promptVersion: EMOJI_GENERATION_PROMPT_VERSION,
  };
}

export async function generateWithGoogleImage(
  input: GenerateImageInput,
  clientFactory?: EmojiImageClientFactory
): Promise<GeneratedImage> {
  const clients = resolveClientFactory(clientFactory);
  const { env, model } = readGoogleImageModel();

  // Model and request bounds are validated against verified pricing before any client or request.
  const pricing = resolveImagePricingConfig({
    provider: 'gemini',
    model,
    env,
    aspectRatio: GOOGLE_IMAGE_ASPECT_RATIO,
    outputCount: IMAGE_OUTPUT_COUNT,
  });
  const modelInput = { ...input, model, pricing, clients };

  return generateWithGoogleGenerateContent(modelInput);
}

export async function generateWithOpenAI(
  { productName, description, apiKey }: GenerateImageInput,
  clientFactory?: EmojiImageClientFactory
): Promise<GeneratedImage> {
  const clients = resolveClientFactory(clientFactory);
  const prompt = getEmojiGenerationPrompt(
    productName,
    description,
    EMOJI_GENERATION_TRANSPARENT_PROMPT_VERSION
  );

  // Model and request bounds are validated against verified pricing before any client or request.
  const model = readModelEnv(OPENAI_IMAGE_MODEL_ENV) ?? DEFAULT_OPENAI_IMAGE_MODEL;
  const pricing = resolveImagePricingConfig({
    provider: 'gpt-image',
    model,
    env: OPENAI_IMAGE_MODEL_ENV,
    size: OPENAI_IMAGE_SIZE,
    quality: OPENAI_IMAGE_QUALITY,
    outputCount: IMAGE_OUTPUT_COUNT,
  });
  requireProviderApiKey({ apiKey, provider: 'gpt-image', model });
  const promptBytes = assertPromptAndContextBounds({
    prompt,
    provider: 'gpt-image',
    model,
    size: pricing.size,
    quality: pricing.quality,
    outputCount: pricing.outputCount,
  });
  const openai = clients.createOpenAIClient({ apiKey });

  const result = await callProviderSdk(
    {
      provider: 'gpt-image',
      model,
      promptChars: prompt.length,
      promptBytes,
      size: pricing.size,
      quality: pricing.quality,
      outputCount: pricing.outputCount,
    },
    () =>
      openai.images.generate({
        model: model as OpenAI.ImageModel,
        prompt,
        size: OPENAI_IMAGE_SIZE,
        quality: OPENAI_IMAGE_QUALITY as 'medium',
        background: OPENAI_IMAGE_BACKGROUND as 'transparent',
      }),
    (res) => ({ openaiUsage: res?.usage })
  );

  const imageBase64 = result.data?.[0]?.b64_json;
  if (!imageBase64) {
    throw new Error('No image data from GPT Image');
  }

  const imageBuffer = Buffer.from(imageBase64, 'base64');
  assertUsablePngBytes(imageBuffer);

  return {
    imageBuffer,
    model,
    prompt,
    promptVersion: EMOJI_GENERATION_TRANSPARENT_PROMPT_VERSION,
  };
}
