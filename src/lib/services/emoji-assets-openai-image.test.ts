import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restoreEnv,
  setEnv,
  snapshotEnv,
  SYNTHETIC_GOOGLE_KEY,
  SYNTHETIC_OPENAI_KEY,
  TINY_PNG_BASE64,
} from '@/test/emoji-image-fixtures';

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

// These checks are about the adapter's bytes; normalization has its own tests.
vi.mock('@/lib/services/emoji-image-normalize', () => ({
  NORMALIZED_EMOJI_MIME: 'image/webp',
  normalizeEmojiImage: async (input: Buffer) => input,
}));

vi.mock('uploadthing/server', () => ({
  UTApi: class UploadThingDouble {
    async uploadFiles(file: File) {
      sdk.uploadFilesCalls.push(file);
      return { data: { url: 'https://utfs.io/f/synthetic.png' } };
    }
  },
}));

const { AiCostUnboundedError } = await import('./emoji-errors');
const { generateAndUploadEmojiAsset } = await import('./emoji-assets');

const PRODUCT = 'Milk';
const DESCRIPTION = 'cold carton';
const GENERATION_INPUT = { productName: PRODUCT, description: DESCRIPTION };

const envSnapshot = snapshotEnv();

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

describe('AC-13 OpenAI unbounded-cost fail-closed guard', () => {
  it.each([
    undefined,
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2',
    'gpt-image-1.5',
  ])(
    'refuses to construct or call OpenAI SDK and uploads nothing for OPENAI_IMAGE_MODEL=%s',
    async (model) => {
      setEnv({ OPENAI_IMAGE_MODEL: model });

      await expect(generateAndUploadEmojiAsset(GENERATION_INPUT)).rejects.toBeInstanceOf(
        AiCostUnboundedError
      );

      expect(sdk.imagesGenerateCalls).toHaveLength(0);
      expect(sdk.uploadFilesCalls).toHaveLength(0);
    }
  );
});
