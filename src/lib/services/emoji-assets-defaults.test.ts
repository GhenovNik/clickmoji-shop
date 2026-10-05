import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEmojiGenerationPrompt } from '@/lib/prompts/emoji-generation';
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

const { generateEmojiImage } = await import('./emoji-assets');

const PRODUCT = 'Milk';
const DESCRIPTION = 'cold carton';
const GENERATION_INPUT = { productName: PRODUCT, description: DESCRIPTION };
const GEMINI_PROMPT = getEmojiGenerationPrompt(PRODUCT, DESCRIPTION);
const OPENAI_PROMPT = getEmojiGenerationPrompt(PRODUCT, DESCRIPTION, 'emoji-image-v1-transparent');

const envSnapshot = snapshotEnv();

type ProviderCase = {
  label: string;
  aiProvider: string | undefined;
  explicitProvider?: string;
  expectedProvider: 'gemini' | 'gpt-image';
};

const GEMINI_BRANCH_PROVIDERS: ProviderCase[] = [
  { label: 'AI_PROVIDER unset', aiProvider: undefined, expectedProvider: 'gemini' },
  { label: 'AI_PROVIDER gemini', aiProvider: 'gemini', expectedProvider: 'gemini' },
  {
    label: 'AI_PROVIDER GPT-IMAGE is not gemini',
    aiProvider: 'GPT-IMAGE',
    expectedProvider: 'gemini',
  },
  { label: 'AI_PROVIDER unknown', aiProvider: 'imagen', expectedProvider: 'gemini' },
  {
    label: 'explicit provider gemini argument',
    aiProvider: 'gpt-image',
    explicitProvider: 'gemini',
    expectedProvider: 'gemini',
  },
];

const OPENAI_BRANCH_PROVIDERS: ProviderCase[] = [
  { label: 'AI_PROVIDER gpt-image', aiProvider: 'gpt-image', expectedProvider: 'gpt-image' },
  {
    label: 'explicit provider gpt-image argument',
    aiProvider: undefined,
    explicitProvider: 'gpt-image',
    expectedProvider: 'gpt-image',
  },
];

const UNSET_MODEL_ENV: Array<{ label: string; value: string | undefined }> = [
  { label: 'unset', value: undefined },
  { label: 'empty', value: '' },
  { label: 'whitespace', value: '   ' },
];

const EXPECTED_GEMINI_CONTENT_CALL = {
  model: 'gemini-3.1-flash-lite-image',
  contents: GEMINI_PROMPT,
  config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
};

const EXPECTED_OPENAI_CALL = {
  model: 'gpt-image-2.5-flare',
  prompt: OPENAI_PROMPT,
  size: '1024x1024',
  quality: 'medium',
  background: 'transparent',
};

beforeEach(() => {
  sdk.constructorCalls.length = 0;
  sdk.generateImagesCalls.length = 0;
  sdk.generateContentCalls.length = 0;
  sdk.imagesGenerateCalls.length = 0;
  sdk.generateImagesImpl = () => ({
    generatedImages: [{ image: { imageBytes: TINY_PNG_BASE64 } }],
  });
  sdk.generateContentImpl = () => generateContentResponse(candidateWith([imagePart()], 'STOP'));
  sdk.imagesGenerateImpl = () => ({ data: [{ b64_json: TINY_PNG_BASE64 }] });
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

describe('AC-1 provider branch selection stays as before', () => {
  for (const providerCase of [...GEMINI_BRANCH_PROVIDERS, ...OPENAI_BRANCH_PROVIDERS]) {
    it(`reports provider ${providerCase.expectedProvider} for ${providerCase.label}`, async () => {
      setEnv({ AI_PROVIDER: providerCase.aiProvider });

      const result = await generateEmojiImage({
        productName: PRODUCT,
        description: DESCRIPTION,
        provider: providerCase.explicitProvider,
      });

      expect(result.provider).toBe(providerCase.expectedProvider);
      if (providerCase.expectedProvider === 'gemini') {
        expect(sdk.generateImagesCalls.length + sdk.generateContentCalls.length).toBe(1);
        expect(sdk.imagesGenerateCalls).toHaveLength(0);
      } else {
        expect(sdk.imagesGenerateCalls).toHaveLength(1);
        expect(sdk.generateImagesCalls).toHaveLength(0);
        expect(sdk.generateContentCalls).toHaveLength(0);
      }
    });
  }

  it('requires only the Google key on the gemini branch', async () => {
    setEnv({ GOOGLE_GENAI_API_KEY: undefined });

    await expect(generateEmojiImage(GENERATION_INPUT)).rejects.toThrow(
      'Google Generative AI API key not configured'
    );
    expect(sdk.constructorCalls).toHaveLength(0);
  });

  it('requires only the OpenAI key on the gpt-image branch', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_API_KEY: undefined });

    await expect(generateEmojiImage(GENERATION_INPUT)).rejects.toThrow(
      'OpenAI API key not configured'
    );
    expect(sdk.constructorCalls).toHaveLength(0);
  });
});

describe('AC-1 default Google model is Gemini 3.1 Flash Lite Image', () => {
  for (const providerCase of GEMINI_BRANCH_PROVIDERS) {
    for (const envCase of UNSET_MODEL_ENV) {
      it(`calls generateContent with the default for ${providerCase.label} and ${envCase.label} GOOGLE_IMAGE_MODEL/IMAGEN_MODEL`, async () => {
        setEnv({
          AI_PROVIDER: providerCase.aiProvider,
          GOOGLE_IMAGE_MODEL: envCase.value,
          IMAGEN_MODEL: envCase.value,
        });

        const result = await generateEmojiImage({
          productName: PRODUCT,
          description: DESCRIPTION,
          provider: providerCase.explicitProvider,
        });

        expect(sdk.generateContentCalls).toHaveLength(1);
        expect(sdk.generateContentCalls[0]).toEqual(EXPECTED_GEMINI_CONTENT_CALL);
        expect(sdk.generateImagesCalls).toHaveLength(0);
        expect(sdk.imagesGenerateCalls).toHaveLength(0);
        expect(result.model).toBe('gemini-3.1-flash-lite-image');
        expect(result.provider).toBe('gemini');
        expect(result.imageBuffer.equals(TINY_PNG_BYTES)).toBe(true);
      });
    }
  }
});

describe('AC-1 default OpenAI model is GPT Image 2.5 Flare with a transparent background', () => {
  for (const providerCase of OPENAI_BRANCH_PROVIDERS) {
    for (const envCase of UNSET_MODEL_ENV) {
      it(`calls images.generate with the FR-1 parameters for ${providerCase.label} and ${envCase.label} OPENAI_IMAGE_MODEL`, async () => {
        setEnv({
          AI_PROVIDER: providerCase.aiProvider,
          OPENAI_IMAGE_MODEL: envCase.value,
        });

        const result = await generateEmojiImage({
          productName: PRODUCT,
          description: DESCRIPTION,
          provider: providerCase.explicitProvider,
        });

        expect(sdk.imagesGenerateCalls).toHaveLength(1);
        expect(sdk.imagesGenerateCalls[0]).toEqual(EXPECTED_OPENAI_CALL);
        expect(sdk.generateImagesCalls).toHaveLength(0);
        expect(sdk.generateContentCalls).toHaveLength(0);
        expect(result.model).toBe('gpt-image-2.5-flare');
        expect(result.provider).toBe('gpt-image');
        expect(result.imageBuffer.equals(TINY_PNG_BYTES)).toBe(true);
      });
    }
  }
});

describe('AC-2 Google model env resolution', () => {
  it('uses the trimmed GOOGLE_IMAGE_MODEL and prefers it over IMAGEN_MODEL', async () => {
    setEnv({
      GOOGLE_IMAGE_MODEL: ' gemini-3.1-flash-image ',
      IMAGEN_MODEL: 'imagen-4.0-generate-001',
    });

    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateContentCalls[0]?.model).toBe('gemini-3.1-flash-image');
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(result.model).toBe('gemini-3.1-flash-image');
  });

  it('keeps the deprecated IMAGEN_MODEL synonym working for generateImages', async () => {
    setEnv({ IMAGEN_MODEL: 'imagen-4.0-generate-001' });

    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.generateImagesCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls[0]).toEqual({
      model: 'imagen-4.0-generate-001',
      prompt: GEMINI_PROMPT,
      config: { numberOfImages: 1, aspectRatio: '1:1' },
    });
    expect(sdk.generateContentCalls).toHaveLength(0);
    expect(result.model).toBe('imagen-4.0-generate-001');
    expect(result.provider).toBe('gemini');
  });

  it('reports a configuration error naming IMAGEN_MODEL for an invalid synonym value', async () => {
    setEnv({ IMAGEN_MODEL: 'foo' });

    const generation = generateEmojiImage(GENERATION_INPUT);

    await expect(generation).rejects.toThrow(/IMAGEN_MODEL/);
    await expect(generation).rejects.toThrow(/value "foo"/);
    expect(sdk.constructorCalls).toHaveLength(0);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.generateContentCalls).toHaveLength(0);
  });

  for (const envCase of UNSET_MODEL_ENV) {
    it(`falls back to the trimmed IMAGEN_MODEL synonym with ${envCase.label} GOOGLE_IMAGE_MODEL`, async () => {
      setEnv({
        GOOGLE_IMAGE_MODEL: envCase.value,
        IMAGEN_MODEL: ' imagen-4.0-generate-001 ',
      });

      const result = await generateEmojiImage(GENERATION_INPUT);

      expect(sdk.generateImagesCalls).toHaveLength(1);
      expect(sdk.generateImagesCalls[0]?.model).toBe('imagen-4.0-generate-001');
      expect(sdk.generateContentCalls).toHaveLength(0);
      expect(result.model).toBe('imagen-4.0-generate-001');
    });
  }

  it('names IMAGEN_MODEL in the configuration error when GOOGLE_IMAGE_MODEL is empty', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: '   ', IMAGEN_MODEL: 'foo' });

    const generation = generateEmojiImage(GENERATION_INPUT);

    await expect(generation).rejects.toThrow(/IMAGEN_MODEL/);
    expect(sdk.constructorCalls).toHaveLength(0);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.generateContentCalls).toHaveLength(0);
  });

  it('ignores invalid Google model env while the OpenAI provider is active', async () => {
    setEnv({
      AI_PROVIDER: 'gpt-image',
      GOOGLE_IMAGE_MODEL: 'gemini-image',
      IMAGEN_MODEL: 'foo',
    });

    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.imagesGenerateCalls[0]).toEqual(EXPECTED_OPENAI_CALL);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(sdk.generateContentCalls).toHaveLength(0);
    expect(result.provider).toBe('gpt-image');
  });

  it('ignores an invalid OPENAI_IMAGE_MODEL while the Google provider is active', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'imagen-4.0-generate-001', OPENAI_IMAGE_MODEL: 'dall-e-3' });

    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.generateImagesCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls[0]?.model).toBe('imagen-4.0-generate-001');
    expect(sdk.imagesGenerateCalls).toHaveLength(0);
    expect(result.provider).toBe('gemini');
  });

  it('does not throw on module import with an invalid image model env', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'gemini-image', IMAGEN_MODEL: 'foo' });
    vi.resetModules();

    const reloadedModule = await import('./emoji-assets');

    expect(typeof reloadedModule.generateEmojiImage).toBe('function');
  });
});

describe('AC-2 OpenAI model env resolution', () => {
  it('uses the trimmed OPENAI_IMAGE_MODEL with the FR-1 request parameters', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_IMAGE_MODEL: ' gpt-image-1.5 ' });

    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.imagesGenerateCalls[0]).toEqual({
      model: 'gpt-image-1.5',
      prompt: OPENAI_PROMPT,
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
    });
    expect(result.model).toBe('gpt-image-1.5');
    expect(result.provider).toBe('gpt-image');
  });

  for (const rejected of [
    'dall-e-3',
    'gpt-image',
    'GPT-Image-2',
    'gpt-image-',
    'models/gpt-image-1',
  ]) {
    it(`reports a configuration error naming OPENAI_IMAGE_MODEL for ${JSON.stringify(rejected)}`, async () => {
      setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_IMAGE_MODEL: rejected });

      const generation = generateEmojiImage(GENERATION_INPUT);

      await expect(generation).rejects.toThrow(/OPENAI_IMAGE_MODEL/);
      await expect(generation).rejects.toThrow(
        new RegExp(`value "${rejected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
      );
      expect(sdk.constructorCalls).toHaveLength(0);
      expect(sdk.imagesGenerateCalls).toHaveLength(0);
    });
  }
});
