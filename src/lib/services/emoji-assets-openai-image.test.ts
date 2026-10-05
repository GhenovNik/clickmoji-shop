import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEmojiGenerationPrompt } from '@/lib/prompts/emoji-generation';
import {
  restoreEnv,
  setEnv,
  snapshotEnv,
  SYNTHETIC_GOOGLE_KEY,
  SYNTHETIC_OPENAI_KEY,
  TINY_PNG_BASE64,
  TINY_PNG_BYTES,
} from '@/test/emoji-image-fixtures';

const TEN_MEBIBYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sdk = vi.hoisted(() => ({
  imagesGenerateCalls: [] as Array<Record<string, unknown>>,
  uploadFilesCalls: [] as Array<File>,
  imagesGenerateImpl: (() => undefined) as (params: Record<string, unknown>) => unknown,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class GoogleGenAIDouble {
    models = {
      generateImages: async () => {
        throw new Error('Google must not be called in this test');
      },
      generateContent: async () => {
        throw new Error('Google must not be called in this test');
      },
    };
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

const { generateAndUploadEmojiAsset } = await import('./emoji-assets');

const PRODUCT = 'Milk';
const DESCRIPTION = 'cold carton';
const GENERATION_INPUT = { productName: PRODUCT, description: DESCRIPTION };

const envSnapshot = snapshotEnv();

/** A byte-exact image of the requested size that starts with the PNG signature. */
function pngOfSize(bytes: number): Buffer {
  const filler = Buffer.alloc(Math.max(bytes - PNG_SIGNATURE.length, 0), 0x41);
  return Buffer.concat([PNG_SIGNATURE, filler]);
}

function respondWithBase64(value: string) {
  sdk.imagesGenerateImpl = () => ({ data: [{ b64_json: value }] });
}

beforeEach(() => {
  sdk.imagesGenerateCalls.length = 0;
  sdk.uploadFilesCalls.length = 0;
  respondWithBase64(TINY_PNG_BASE64);
  setEnv({
    AI_PROVIDER: 'gpt-image',
    IMAGEN_MODEL: undefined,
    GOOGLE_IMAGE_MODEL: undefined,
    OPENAI_IMAGE_MODEL: undefined,
    GOOGLE_GENAI_API_KEY: SYNTHETIC_GOOGLE_KEY,
    OPENAI_API_KEY: SYNTHETIC_OPENAI_KEY,
  });
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

describe('AC-13 OpenAI request body', () => {
  it('sends the model, prompt and the FR-1 size, quality and background parameters', async () => {
    await generateAndUploadEmojiAsset(GENERATION_INPUT);

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.imagesGenerateCalls[0]).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: getEmojiGenerationPrompt(PRODUCT, DESCRIPTION, 'emoji-image-v1-transparent'),
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
    });
  });
});

describe('AC-13 OpenAI response byte checks', () => {
  it('keeps the previous error and uploads nothing when b64_json is missing', async () => {
    sdk.imagesGenerateImpl = () => ({ data: [] });

    await expect(generateAndUploadEmojiAsset(GENERATION_INPUT)).rejects.toThrow(
      'No image data from GPT Image'
    );
    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('rejects non-PNG bytes as invalid-png', async () => {
    respondWithBase64(Buffer.from('definitely not a png').toString('base64'));

    await expect(generateAndUploadEmojiAsset(GENERATION_INPUT)).rejects.toThrow(/invalid-png/);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('rejects data that decodes to zero bytes as empty-image', async () => {
    respondWithBase64('=');

    await expect(generateAndUploadEmojiAsset(GENERATION_INPUT)).rejects.toThrow(/empty-image/);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('keeps the previous error and uploads nothing when b64_json is an empty string', async () => {
    respondWithBase64('');

    await expect(generateAndUploadEmojiAsset(GENERATION_INPUT)).rejects.toThrow(
      'No image data from GPT Image'
    );
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('accepts an image of exactly 10 MiB with a PNG signature', async () => {
    const exact = pngOfSize(TEN_MEBIBYTES);
    respondWithBase64(exact.toString('base64'));

    const asset = await generateAndUploadEmojiAsset(GENERATION_INPUT);

    expect(exact.length).toBe(TEN_MEBIBYTES);
    expect(asset.imageUrl).toBe('https://utfs.io/f/synthetic.png');
    expect(sdk.uploadFilesCalls).toHaveLength(1);
    const uploaded = Buffer.from(await sdk.uploadFilesCalls[0].arrayBuffer());
    expect(uploaded.equals(exact)).toBe(true);
  });

  it('rejects an image of 10 MiB plus one byte as too-large', async () => {
    respondWithBase64(pngOfSize(TEN_MEBIBYTES + 1).toString('base64'));

    await expect(generateAndUploadEmojiAsset(GENERATION_INPUT)).rejects.toThrow(/too-large/);
    expect(sdk.uploadFilesCalls).toHaveLength(0);
  });

  it('uploads the decoded PNG bytes unchanged on success', async () => {
    const asset = await generateAndUploadEmojiAsset(GENERATION_INPUT);

    expect(asset.imageUrl).toBe('https://utfs.io/f/synthetic.png');
    expect(sdk.uploadFilesCalls).toHaveLength(1);
    const uploaded = Buffer.from(await sdk.uploadFilesCalls[0].arrayBuffer());
    expect(uploaded.equals(TINY_PNG_BYTES)).toBe(true);
  });
});
