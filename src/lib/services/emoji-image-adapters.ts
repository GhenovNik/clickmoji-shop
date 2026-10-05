import { GoogleGenAI } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';
import OpenAI from 'openai';
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

export const DEFAULT_GOOGLE_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const OPENAI_IMAGE_SIZE = '1024x1024';
const OPENAI_IMAGE_QUALITY = 'medium';
const OPENAI_IMAGE_BACKGROUND = 'transparent';

// Model id grammar, not a catalogue of models: an id that matches is routed, it is not guaranteed
// that the model itself can generate images.
const IMAGEN_MODEL_ID_PATTERN = /^imagen-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const GEMINI_IMAGE_MODEL_ID_PATTERN =
  /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*-image(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;
const OPENAI_IMAGE_MODEL_ID_PATTERN = /^gpt-image-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

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

type GenerateImageWithModelInput = GenerateImageInput & { model: string };

type GeneratedImage = {
  imageBuffer: Buffer;
  model: string;
  prompt: string;
  promptVersion: EmojiGenerationPromptVersion;
};

type GoogleImageAdapter = 'generateImages' | 'generateContent';

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
  createOpenAIClient: ({ apiKey }) => new OpenAI({ apiKey }),
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

/**
 * FR-9 + FR-6: one SDK call per generation, no retry of our own. A quota or auth failure becomes a
 * typed `EmojiProviderUnavailableError`; every other SDK failure is rethrown unchanged, and the SDK
 * error itself is not attached to the typed error so it cannot reach a server log.
 */
async function callProviderSdk<T>(
  {
    provider,
    model,
  }: {
    provider: EmojiProvider;
    model: string;
  },
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const reason = classifyProviderFailure(error);
    if (reason) {
      throw new EmojiProviderUnavailableError({ reason, provider, model });
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

function resolveGoogleImageAdapter(model: string, env: string): GoogleImageAdapter {
  if (IMAGEN_MODEL_ID_PATTERN.test(model)) {
    return 'generateImages';
  }
  if (GEMINI_IMAGE_MODEL_ID_PATTERN.test(model)) {
    return 'generateContent';
  }
  throw new EmojiImageGenerationError(
    'configuration',
    `Invalid ${env} value "${model}": expected an Imagen model id (${IMAGEN_MODEL_ID_PATTERN.source}) for generateImages or a Gemini image model id (${GEMINI_IMAGE_MODEL_ID_PATTERN.source}) for generateContent`
  );
}

function resolveOpenAIImageModel(): string {
  const model = readModelEnv(OPENAI_IMAGE_MODEL_ENV) ?? DEFAULT_OPENAI_IMAGE_MODEL;
  if (!OPENAI_IMAGE_MODEL_ID_PATTERN.test(model)) {
    throw new EmojiImageGenerationError(
      'configuration',
      `Invalid ${OPENAI_IMAGE_MODEL_ENV} value "${model}": expected a GPT Image model id (${OPENAI_IMAGE_MODEL_ID_PATTERN.source}) that supports images.generate with a base64 PNG response`
    );
  }
  return model;
}

async function generateWithGoogleImages({
  productName,
  description,
  apiKey,
  model,
  clients,
}: GenerateImageWithModelInput & { clients: ResolvedClientFactory }): Promise<GeneratedImage> {
  requireProviderApiKey({ apiKey, provider: 'gemini', model });
  const prompt = getEmojiGenerationPrompt(productName, description);
  const ai = clients.createGoogleClient({ apiKey });

  const response = await callProviderSdk({ provider: 'gemini', model }, () =>
    ai.models.generateImages({
      model,
      prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: '1:1',
      },
    })
  );

  if (!response?.generatedImages?.length) {
    throw new EmojiImageGenerationError(
      'blocked',
      'No image generated by Imagen - content may have been blocked by safety filters'
    );
  }

  const imageBytes = response.generatedImages[0]?.image?.imageBytes;
  if (!imageBytes) {
    throw new Error('Missing image data in Imagen response');
  }

  return {
    imageBuffer: Buffer.from(imageBytes, 'base64'),
    model,
    prompt,
    promptVersion: EMOJI_GENERATION_PROMPT_VERSION,
  };
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
  clients,
}: GenerateImageWithModelInput & { clients: ResolvedClientFactory }): Promise<GeneratedImage> {
  requireProviderApiKey({ apiKey, provider: 'gemini', model });
  const prompt = getEmojiGenerationPrompt(productName, description);
  const ai = clients.createGoogleClient({ apiKey });

  const response = await callProviderSdk({ provider: 'gemini', model }, () =>
    ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '1:1' },
      },
    })
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

  // Configuration is validated before any client is created or any request is sent.
  const adapter = resolveGoogleImageAdapter(model, env);
  const modelInput = { ...input, model, clients };

  if (adapter === 'generateImages') {
    return generateWithGoogleImages(modelInput);
  }
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

  // Configuration is validated before any client is created or any request is sent.
  const model = resolveOpenAIImageModel();
  requireProviderApiKey({ apiKey, provider: 'gpt-image', model });
  const openai = clients.createOpenAIClient({ apiKey });

  const result = await callProviderSdk({ provider: 'gpt-image', model }, () =>
    openai.images.generate({
      model: model as OpenAI.ImageModel,
      prompt,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY as 'medium',
      background: OPENAI_IMAGE_BACKGROUND as 'transparent',
    })
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
