import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMOJI_GENERATION_PROMPT_VERSION,
  getEmojiGenerationCacheKey,
} from '@/lib/prompts/emoji-generation';
import {
  candidateWith,
  generateContentResponse,
  imagePart,
  restoreEnv,
  setEnv,
  snapshotEnv,
  SYNTHETIC_GOOGLE_KEY,
  SYNTHETIC_OPENAI_KEY,
  TINY_PNG_BASE64,
  TINY_PNG_BYTES,
} from '@/test/emoji-image-fixtures';

const sdk = vi.hoisted(() => ({
  constructorCalls: [] as Array<Record<string, unknown>>,
  generateImagesCalls: [] as Array<Record<string, unknown>>,
  generateContentCalls: [] as Array<Record<string, unknown>>,
  imagesGenerateCalls: [] as Array<Record<string, unknown>>,
  uploadFilesCalls: [] as Array<File>,
  generateImagesImpl: (() => undefined) as (params: Record<string, unknown>) => unknown,
  generateContentImpl: (() => undefined) as (params: Record<string, unknown>) => unknown,
  imagesGenerateImpl: (() => undefined) as (params: Record<string, unknown>) => unknown,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class GoogleGenAIDouble {
    models = {
      generateImages: async (params: Record<string, unknown>) => {
        sdk.generateImagesCalls.push(params);
        return sdk.generateImagesImpl(params);
      },
      generateContent: async (params: Record<string, unknown>) => {
        sdk.generateContentCalls.push(params);
        return sdk.generateContentImpl(params);
      },
    };

    constructor(options: Record<string, unknown>) {
      sdk.constructorCalls.push(options);
    }
  },
}));

vi.mock('openai', () => ({
  default: class OpenAIDouble {
    images = {
      generate: async (params: Record<string, unknown>) => {
        sdk.imagesGenerateCalls.push(params);
        return sdk.imagesGenerateImpl(params);
      },
    };

    constructor(options: Record<string, unknown>) {
      sdk.constructorCalls.push(options);
    }
  },
}));

vi.mock('uploadthing/server', () => ({
  UTApi: class UploadThingDouble {
    async uploadFiles(file: File) {
      sdk.uploadFilesCalls.push(file);
      return { data: { url: 'https://utfs.io/f/synthetic.png' } };
    }
  },
}));

const { generateAndUploadEmojiAsset, generateEmojiImage } = await import('./emoji-assets');

const PRODUCT = 'Milk';
const DESCRIPTION = 'cold carton';
const ASSET_INPUT = { productName: PRODUCT, description: DESCRIPTION };

const envSnapshot = snapshotEnv();

function expectUnchangedMetadata(
  result: { provider: string; promptVersion: string; cacheKey: string },
  provider: string
) {
  expect(result.provider).toBe(provider);
  if (provider === 'gpt-image') {
    expect(result.promptVersion).toBe('emoji-image-v1-transparent');
    expect(result.cacheKey).toBe('emoji-image-v1-transparent:milk:cold carton');
    return;
  }
  expect(result.promptVersion).toBe(EMOJI_GENERATION_PROMPT_VERSION);
  expect(result.cacheKey).toBe(getEmojiGenerationCacheKey(PRODUCT, DESCRIPTION));
}

beforeEach(() => {
  sdk.constructorCalls.length = 0;
  sdk.generateImagesCalls.length = 0;
  sdk.generateContentCalls.length = 0;
  sdk.imagesGenerateCalls.length = 0;
  sdk.uploadFilesCalls.length = 0;
  sdk.generateImagesImpl = () => ({
    generatedImages: [{ image: { imageBytes: TINY_PNG_BASE64 } }],
  });
  sdk.generateContentImpl = () => generateContentResponse(candidateWith([imagePart()], 'STOP'));
  sdk.imagesGenerateImpl = () => ({ data: [{ b64_json: TINY_PNG_BASE64 }] });
  setEnv({
    AI_PROVIDER: undefined,
    IMAGEN_MODEL: 'imagen-4.0-fast-generate-001',
    GOOGLE_IMAGE_MODEL: undefined,
    OPENAI_IMAGE_MODEL: undefined,
    GOOGLE_GENAI_API_KEY: SYNTHETIC_GOOGLE_KEY,
    OPENAI_API_KEY: SYNTHETIC_OPENAI_KEY,
  });
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

describe('AC-6 returned model id and unchanged metadata', () => {
  it('reports the default Gemini image model and unchanged metadata', async () => {
    setEnv({ IMAGEN_MODEL: undefined });

    const result = await generateEmojiImage(ASSET_INPUT);

    expect(result.model).toBe('gemini-3.1-flash-lite-image');
    expectUnchangedMetadata(result, 'gemini');
  });

  it('reports the deprecated IMAGEN_MODEL synonym and unchanged metadata', async () => {
    const result = await generateEmojiImage(ASSET_INPUT);

    expect(result.model).toBe('imagen-4.0-fast-generate-001');
    expectUnchangedMetadata(result, 'gemini');
  });

  it('reports the configured Google imagen model and unchanged metadata', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'imagen-4.0-generate-001' });

    const result = await generateEmojiImage(ASSET_INPUT);

    expect(result.model).toBe('imagen-4.0-generate-001');
    expectUnchangedMetadata(result, 'gemini');
  });

  it('reports the configured Google gemini image model and unchanged metadata', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'gemini-3.1-flash-image' });

    const result = await generateEmojiImage(ASSET_INPUT);

    expect(result.model).toBe('gemini-3.1-flash-image');
    expectUnchangedMetadata(result, 'gemini');
  });

  it('reports the default OpenAI model and transparent-variant metadata', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', IMAGEN_MODEL: undefined });

    const result = await generateEmojiImage(ASSET_INPUT);

    expect(result.model).toBe('gpt-image-2.5-flare');
    expectUnchangedMetadata(result, 'gpt-image');
  });

  it('reports the configured OpenAI model and transparent-variant metadata', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_IMAGE_MODEL: 'gpt-image-2' });

    const result = await generateEmojiImage(ASSET_INPUT);

    expect(result.model).toBe('gpt-image-2');
    expectUnchangedMetadata(result, 'gpt-image');
  });

  it('keeps generateAndUploadEmojiAsset metadata for the deprecated synonym path', async () => {
    const asset = await generateAndUploadEmojiAsset(ASSET_INPUT);

    expect(asset.imageUrl).toBe('https://utfs.io/f/synthetic.png');
    expect(asset.model).toBe('imagen-4.0-fast-generate-001');
    expectUnchangedMetadata(asset, 'gemini');
    expect(sdk.uploadFilesCalls).toHaveLength(1);
  });

  it('keeps generateAndUploadEmojiAsset metadata for the default generateContent path', async () => {
    setEnv({ IMAGEN_MODEL: undefined });

    const asset = await generateAndUploadEmojiAsset(ASSET_INPUT);

    expect(asset.imageUrl).toBe('https://utfs.io/f/synthetic.png');
    expect(asset.model).toBe('gemini-3.1-flash-lite-image');
    expectUnchangedMetadata(asset, 'gemini');
    expect(sdk.uploadFilesCalls).toHaveLength(1);
  });

  it('keeps generateAndUploadEmojiAsset metadata for the Google gemini image path', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'gemini-3.1-flash-image' });

    const asset = await generateAndUploadEmojiAsset(ASSET_INPUT);

    expect(asset.imageUrl).toBe('https://utfs.io/f/synthetic.png');
    expect(asset.model).toBe('gemini-3.1-flash-image');
    expectUnchangedMetadata(asset, 'gemini');
    expect(sdk.uploadFilesCalls).toHaveLength(1);
  });

  it('keeps generateAndUploadEmojiAsset metadata for the OpenAI path', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_IMAGE_MODEL: 'gpt-image-2' });

    const asset = await generateAndUploadEmojiAsset(ASSET_INPUT);

    expect(asset.imageUrl).toBe('https://utfs.io/f/synthetic.png');
    expect(asset.model).toBe('gpt-image-2');
    expectUnchangedMetadata(asset, 'gpt-image');
    expect(sdk.uploadFilesCalls).toHaveLength(1);
  });
});

describe('AC-8 exactly one adapter attempt per generation', () => {
  it('performs a single generateImages attempt when the legacy SDK call rejects', async () => {
    sdk.generateImagesImpl = () => {
      throw new Error('provider unavailable');
    };

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow('provider unavailable');

    expect(sdk.generateImagesCalls).toHaveLength(1);
    expect(sdk.generateContentCalls).toHaveLength(0);
    expect(sdk.imagesGenerateCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('performs a single generateImages attempt when the configured imagen model call rejects', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'imagen-4.0-generate-001' });
    sdk.generateImagesImpl = () => {
      throw new Error('provider unavailable');
    };

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow('provider unavailable');

    expect(sdk.generateImagesCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls[0]?.model).toBe('imagen-4.0-generate-001');
    expect(sdk.generateContentCalls).toHaveLength(0);
    expect(sdk.imagesGenerateCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('performs a single generateContent attempt when the SDK call rejects', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'gemini-3.1-flash-image' });
    sdk.generateContentImpl = () => {
      throw new Error('provider unavailable');
    };

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow('provider unavailable');

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.imagesGenerateCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('performs a single generateContent attempt for a blocked soft failure', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'gemini-3.1-flash-image' });
    sdk.generateContentImpl = () =>
      generateContentResponse(candidateWith([imagePart()], 'IMAGE_SAFETY'));

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow(/blocked/);

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.imagesGenerateCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('performs a single generateContent attempt for a no-image soft failure', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'gemini-3.1-flash-image' });
    sdk.generateContentImpl = () => generateContentResponse({ finishReason: 'STOP' });

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow(/no-image/);

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.imagesGenerateCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('performs a single images.generate attempt when the OpenAI call rejects', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_IMAGE_MODEL: 'gpt-image-2' });
    sdk.imagesGenerateImpl = () => {
      throw new Error('provider unavailable');
    };

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow('provider unavailable');

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.generateContentCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('performs a single images.generate attempt when the OpenAI response has no image data', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image' });
    sdk.imagesGenerateImpl = () => ({ data: [] });

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow(
      'No image data from GPT Image'
    );

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.generateContentCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('uploads the decoded PNG bytes on the gemini image path', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'gemini-3.1-flash-image' });

    const asset = await generateAndUploadEmojiAsset(ASSET_INPUT);

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(1);
    const bytes = Buffer.from(await sdk.uploadFilesCalls[0].arrayBuffer());
    expect(bytes.equals(TINY_PNG_BYTES)).toBe(true);
    expect(asset.imageUrl).toBe('https://utfs.io/f/synthetic.png');
  });

  it('performs a single generateContent attempt for the default model when the call rejects', async () => {
    setEnv({ IMAGEN_MODEL: undefined });
    sdk.generateContentImpl = () => {
      throw new Error('provider unavailable');
    };

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow('provider unavailable');

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateContentCalls[0]?.model).toBe('gemini-3.1-flash-lite-image');
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.imagesGenerateCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('performs a single generateContent attempt for the default model on a blocked soft failure', async () => {
    setEnv({ IMAGEN_MODEL: undefined });
    sdk.generateContentImpl = () =>
      generateContentResponse(candidateWith([imagePart()], 'IMAGE_SAFETY'));

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow(/blocked/);

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.imagesGenerateCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('performs a single images.generate attempt for the default model when the call rejects', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', IMAGEN_MODEL: undefined });
    sdk.imagesGenerateImpl = () => {
      throw new Error('provider unavailable');
    };

    await expect(generateAndUploadEmojiAsset(ASSET_INPUT)).rejects.toThrow('provider unavailable');

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.imagesGenerateCalls[0]?.model).toBe('gpt-image-2.5-flare');
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.generateContentCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('uploads the decoded PNG bytes on the default generateContent path', async () => {
    setEnv({ IMAGEN_MODEL: undefined });

    const asset = await generateAndUploadEmojiAsset(ASSET_INPUT);

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateContentCalls[0]?.model).toBe('gemini-3.1-flash-lite-image');
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.uploadFilesCalls).toHaveLength(1);
    const bytes = Buffer.from(await sdk.uploadFilesCalls[0].arrayBuffer());
    expect(bytes.equals(TINY_PNG_BYTES)).toBe(true);
  });
});
