import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMOJI_GENERATION_PROMPT_VERSION,
  getEmojiGenerationCacheKey,
  getEmojiGenerationPrompt,
} from '@/lib/prompts/emoji-generation';
import {
  restoreEnv,
  setEnv,
  snapshotEnv,
  SYNTHETIC_GOOGLE_KEY,
  SYNTHETIC_OPENAI_KEY,
  TINY_PNG_BYTES,
} from '@/test/emoji-image-fixtures';

const sdk = vi.hoisted(() => ({
  constructorCalls: [] as Array<Record<string, unknown>>,
  generateImagesCalls: [] as Array<Record<string, unknown>>,
  generateContentCalls: [] as Array<Record<string, unknown>>,
  imagesGenerateCalls: [] as Array<Record<string, unknown>>,
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
    uploadFiles = async () => {
      throw new Error('upload must not run in this test');
    };
  },
}));

const { generateEmojiImage } = await import('./emoji-assets');

const PRODUCT = 'Milk';
const DESCRIPTION = 'cold carton';

const envSnapshot = snapshotEnv();

beforeEach(() => {
  sdk.constructorCalls.length = 0;
  sdk.generateImagesCalls.length = 0;
  sdk.generateContentCalls.length = 0;
  sdk.imagesGenerateCalls.length = 0;
  sdk.generateImagesImpl = () => ({
    generatedImages: [{ image: { imageBytes: TINY_PNG_BYTES.toString('base64') } }],
  });
  sdk.generateContentImpl = () => ({ candidates: [] });
  sdk.imagesGenerateImpl = () => ({ data: [{ b64_json: TINY_PNG_BYTES.toString('base64') }] });
  setEnv({
    AI_PROVIDER: undefined,
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

type LegacyImagenCase = {
  label: string;
  imagenModel: string | undefined;
  expectedModel: string;
};

const LEGACY_IMAGEN_CASES: LegacyImagenCase[] = [
  { label: 'IMAGEN_MODEL unset', imagenModel: undefined, expectedModel: 'imagen-4.0-generate-001' },
  { label: 'IMAGEN_MODEL empty', imagenModel: '', expectedModel: 'imagen-4.0-generate-001' },
  { label: 'IMAGEN_MODEL single space', imagenModel: ' ', expectedModel: ' ' },
  {
    label: 'IMAGEN_MODEL imagen-4.0-fast-generate-001',
    imagenModel: 'imagen-4.0-fast-generate-001',
    expectedModel: 'imagen-4.0-fast-generate-001',
  },
  {
    label: 'IMAGEN_MODEL gemini-3.1-flash-image',
    imagenModel: 'gemini-3.1-flash-image',
    expectedModel: 'gemini-3.1-flash-image',
  },
  { label: 'IMAGEN_MODEL foo', imagenModel: 'foo', expectedModel: 'foo' },
];

type LegacyProviderCase = {
  label: string;
  aiProvider: string | undefined;
  explicitProvider?: string;
  expectedProvider: 'gemini' | 'gpt-image';
};

const GEMINI_PROVIDERS: LegacyProviderCase[] = [
  { label: 'AI_PROVIDER unset', aiProvider: undefined, expectedProvider: 'gemini' },
  { label: 'AI_PROVIDER gemini', aiProvider: 'gemini', expectedProvider: 'gemini' },
  { label: 'AI_PROVIDER GPT-IMAGE', aiProvider: 'GPT-IMAGE', expectedProvider: 'gemini' },
  { label: 'AI_PROVIDER gpt-image', aiProvider: 'gpt-image', expectedProvider: 'gpt-image' },
  {
    label: 'explicit provider gpt-image argument',
    aiProvider: undefined,
    explicitProvider: 'gpt-image',
    expectedProvider: 'gpt-image',
  },
];

async function runGeneration(providerCase: LegacyProviderCase) {
  setEnv({ AI_PROVIDER: providerCase.aiProvider });
  return generateEmojiImage({
    productName: PRODUCT,
    description: DESCRIPTION,
    provider: providerCase.explicitProvider,
  });
}

describe('AC-1 legacy Google image path without image model env variables', () => {
  for (const imagenCase of LEGACY_IMAGEN_CASES) {
    for (const providerCase of GEMINI_PROVIDERS.filter(
      (entry) => entry.expectedProvider === 'gemini'
    )) {
      it(`keeps generateImages with ${imagenCase.label} and ${providerCase.label}`, async () => {
        setEnv({ IMAGEN_MODEL: imagenCase.imagenModel });
        const result = await runGeneration(providerCase);

        expect(sdk.generateImagesCalls).toHaveLength(1);
        expect(sdk.generateImagesCalls[0]).toEqual({
          model: imagenCase.expectedModel,
          prompt: getEmojiGenerationPrompt(PRODUCT, DESCRIPTION),
          config: { numberOfImages: 1, aspectRatio: '1:1' },
        });
        expect(sdk.generateContentCalls).toHaveLength(0);
        expect(sdk.imagesGenerateCalls).toHaveLength(0);
        expect(result.model).toBe(imagenCase.expectedModel);
        expect(result.provider).toBe('gemini');
        expect(result.imageBuffer.equals(TINY_PNG_BYTES)).toBe(true);
      });
    }

    for (const providerCase of GEMINI_PROVIDERS.filter(
      (entry) => entry.expectedProvider === 'gpt-image'
    )) {
      it(`keeps images.generate with gpt-image-1.5 for ${imagenCase.label} and ${providerCase.label}`, async () => {
        setEnv({ IMAGEN_MODEL: imagenCase.imagenModel });
        const result = await runGeneration(providerCase);

        expect(sdk.imagesGenerateCalls).toHaveLength(1);
        expect(sdk.imagesGenerateCalls[0]).toEqual({
          model: 'gpt-image-1.5',
          prompt: getEmojiGenerationPrompt(PRODUCT, DESCRIPTION),
        });
        expect(sdk.generateImagesCalls).toHaveLength(0);
        expect(sdk.generateContentCalls).toHaveLength(0);
        expect(result.model).toBe('gpt-image-1.5');
        expect(result.provider).toBe('gpt-image');
        expect(result.imageBuffer.equals(TINY_PNG_BYTES)).toBe(true);
      });
    }
  }

  for (const providerCase of [
    { label: 'empty', value: '' },
    { label: 'whitespace', value: '   ' },
  ]) {
    it(`keeps legacy Gemini behaviour with ${providerCase.label} GOOGLE_IMAGE_MODEL`, async () => {
      setEnv({
        IMAGEN_MODEL: 'imagen-4.0-fast-generate-001',
        GOOGLE_IMAGE_MODEL: providerCase.value,
      });
      const result = await runGeneration({
        label: 'AI_PROVIDER unset',
        aiProvider: undefined,
        expectedProvider: 'gemini',
      });

      expect(sdk.generateImagesCalls).toHaveLength(1);
      expect(sdk.generateImagesCalls[0]?.model).toBe('imagen-4.0-fast-generate-001');
      expect(sdk.generateContentCalls).toHaveLength(0);
      expect(result.model).toBe('imagen-4.0-fast-generate-001');
      expect(result.provider).toBe('gemini');
    });

    it(`keeps gpt-image-1.5 with ${providerCase.label} OPENAI_IMAGE_MODEL`, async () => {
      setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_IMAGE_MODEL: providerCase.value });
      const result = await generateEmojiImage({ productName: PRODUCT, description: DESCRIPTION });

      expect(sdk.imagesGenerateCalls).toHaveLength(1);
      expect(sdk.imagesGenerateCalls[0]?.model).toBe('gpt-image-1.5');
      expect(result.model).toBe('gpt-image-1.5');
    });
  }

  it('keeps the legacy Imagen error text when no image was generated', async () => {
    sdk.generateImagesImpl = () => ({ generatedImages: [] });

    await expect(
      generateEmojiImage({ productName: PRODUCT, description: DESCRIPTION })
    ).rejects.toThrow(
      'No image generated by Imagen - content may have been blocked by safety filters'
    );
  });

  it('keeps the legacy Imagen error text when image bytes are missing', async () => {
    sdk.generateImagesImpl = () => ({ generatedImages: [{ image: {} }] });

    await expect(
      generateEmojiImage({ productName: PRODUCT, description: DESCRIPTION })
    ).rejects.toThrow('Missing image data in Imagen response');
  });

  it('keeps the legacy OpenAI error text when b64_json is missing', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image' });
    sdk.imagesGenerateImpl = () => ({ data: [] });

    await expect(
      generateEmojiImage({ productName: PRODUCT, description: DESCRIPTION })
    ).rejects.toThrow('No image data from GPT Image');
  });
});

describe('AC-2 model env variables are opt-in', () => {
  it('ignores an invalid GOOGLE_IMAGE_MODEL while the OpenAI provider is active', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', GOOGLE_IMAGE_MODEL: 'gemini-image' });
    const result = await generateEmojiImage({ productName: PRODUCT, description: DESCRIPTION });

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.imagesGenerateCalls[0]?.model).toBe('gpt-image-1.5');
    expect(result.provider).toBe('gpt-image');
  });

  it('does not throw on module import with an invalid GOOGLE_IMAGE_MODEL', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'gemini-image' });
    vi.resetModules();

    const reloadedModule = await import('./emoji-assets');

    expect(typeof reloadedModule.generateEmojiImage).toBe('function');
  });

  it('uses the trimmed GOOGLE_IMAGE_MODEL for generateImages instead of IMAGEN_MODEL', async () => {
    setEnv({
      GOOGLE_IMAGE_MODEL: ' imagen-4.0-generate-001 ',
      IMAGEN_MODEL: 'imagen-4.0-fast-generate-001',
    });

    const result = await generateEmojiImage({ productName: PRODUCT, description: DESCRIPTION });

    expect(sdk.generateImagesCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls[0]?.model).toBe('imagen-4.0-generate-001');
    expect(sdk.generateContentCalls).toHaveLength(0);
    expect(result.model).toBe('imagen-4.0-generate-001');
  });

  it('uses the trimmed OPENAI_IMAGE_MODEL for images.generate', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_IMAGE_MODEL: ' gpt-image-2 ' });

    const result = await generateEmojiImage({ productName: PRODUCT, description: DESCRIPTION });

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.imagesGenerateCalls[0]?.model).toBe('gpt-image-2');
    expect(result.model).toBe('gpt-image-2');
    expect(result.provider).toBe('gpt-image');
  });

  it('keeps promptVersion and cacheKey untouched by the model switch', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'imagen-4.0-generate-001' });

    const result = await generateEmojiImage({ productName: PRODUCT, description: DESCRIPTION });

    expect(result.promptVersion).toBe(EMOJI_GENERATION_PROMPT_VERSION);
    expect(result.cacheKey).toBe(getEmojiGenerationCacheKey(PRODUCT, DESCRIPTION));
  });
});
