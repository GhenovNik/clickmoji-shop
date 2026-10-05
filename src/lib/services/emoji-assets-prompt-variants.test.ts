import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '@/test/emoji-image-fixtures';

const sdk = vi.hoisted(() => ({
  generateImagesCalls: [] as Array<Record<string, unknown>>,
  generateContentCalls: [] as Array<Record<string, unknown>>,
  imagesGenerateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class GoogleGenAIDouble {
    models = {
      generateImages: async (params: Record<string, unknown>) => {
        sdk.generateImagesCalls.push(params);
        return { generatedImages: [{ image: { imageBytes: TINY_PNG_BASE64 } }] };
      },
      generateContent: async (params: Record<string, unknown>) => {
        sdk.generateContentCalls.push(params);
        return generateContentResponse(candidateWith([imagePart()], 'STOP'));
      },
    };
  },
}));

vi.mock('openai', () => ({
  default: class OpenAIDouble {
    images = {
      generate: async (params: Record<string, unknown>) => {
        sdk.imagesGenerateCalls.push(params);
        return { data: [{ b64_json: TINY_PNG_BASE64 }] };
      },
    };
  },
}));

const { generateEmojiImage } = await import('./emoji-assets');

const PRODUCT = 'Milk';
const DESCRIPTION = 'cold carton';
const GENERATION_INPUT = { productName: PRODUCT, description: DESCRIPTION };

// Snapshot of the template the Google path used before this change; FR-8 keeps it verbatim.
const GOOGLE_PROMPT_SNAPSHOT = [
  'Vector illustration icon of Milk.',
  'Product description/context: cold carton.',
  'Use this only as visual context for the icon shape/details.',
  'Style: 3D emoji style, semi-flat look with soft volume.',
  'MUST BE:',
  'smooth rounded shapes,',
  'soft plastic-like shading,',
  'subtle gradients for depth and volume,',
  'gentle specular highlights,',
  'soft even lighting,',
  'NO shadows or drop shadows,',
  'NO black outlines (outline-free),',
  'no text or symbols,',
  'centered composition,',
  'lots of white padding,',
  'isolated on pure white background (#FFFFFF).',
  'High quality emoji-style icon, consistent emoji pack look.',
  'Minimalist but detailed enough to look appetizing.',
].join('\n');

const SHARED_PROMPT_LINES = [
  'Vector illustration icon of Milk.',
  'Product description/context: cold carton.',
  'Use this only as visual context for the icon shape/details.',
  'Style: 3D emoji style, semi-flat look with soft volume.',
  'MUST BE:',
  'smooth rounded shapes,',
  'soft plastic-like shading,',
  'subtle gradients for depth and volume,',
  'gentle specular highlights,',
  'soft even lighting,',
  'NO shadows or drop shadows,',
  'NO black outlines (outline-free),',
  'no text or symbols,',
  'centered composition,',
  'High quality emoji-style icon, consistent emoji pack look.',
  'Minimalist but detailed enough to look appetizing.',
];

const GOOGLE_CACHE_KEY = 'emoji-image-v1:milk:cold carton';
const OPENAI_CACHE_KEY = 'emoji-image-v1-transparent:milk:cold carton';

const envSnapshot = snapshotEnv();

beforeEach(() => {
  sdk.generateImagesCalls.length = 0;
  sdk.generateContentCalls.length = 0;
  sdk.imagesGenerateCalls.length = 0;
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

describe('AC-14 Google prompt variant', () => {
  it('keeps the previous template byte for byte on the default generateContent path', async () => {
    await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateContentCalls[0]?.contents).toBe(GOOGLE_PROMPT_SNAPSHOT);
  });

  it('keeps the previous template on the Imagen generateImages synonym path', async () => {
    setEnv({ IMAGEN_MODEL: 'imagen-4.0-generate-001' });

    await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.generateImagesCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls[0]?.prompt).toBe(GOOGLE_PROMPT_SNAPSHOT);
  });

  it('reports promptVersion emoji-image-v1 and the previous cacheKey on the Gemini path', async () => {
    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(result.promptVersion).toBe('emoji-image-v1');
    expect(result.cacheKey).toBe(GOOGLE_CACHE_KEY);
  });

  it('reports promptVersion emoji-image-v1 and the previous cacheKey on the Imagen path', async () => {
    setEnv({ GOOGLE_IMAGE_MODEL: 'imagen-4.0-generate-001' });

    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(result.promptVersion).toBe('emoji-image-v1');
    expect(result.cacheKey).toBe(GOOGLE_CACHE_KEY);
  });
});

describe('AC-14 OpenAI prompt variant for a transparent background', () => {
  it('asks for generous transparent padding and no background colour or fill', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image' });

    await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.imagesGenerateCalls).toHaveLength(1);
    expect(sdk.imagesGenerateCalls[0]?.prompt).toContain(
      'generous transparent padding, no background colour or fill'
    );
  });

  it('asks for isolation on a fully transparent background', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image' });

    await generateEmojiImage(GENERATION_INPUT);

    expect(sdk.imagesGenerateCalls[0]?.prompt).toContain(
      'isolated on a fully transparent background'
    );
  });

  it('drops both white-field lines of the Google template', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image' });

    await generateEmojiImage(GENERATION_INPUT);

    const prompt = String(sdk.imagesGenerateCalls[0]?.prompt);
    expect(prompt).not.toMatch(/white padding/i);
    expect(prompt).not.toMatch(/white background/i);
    expect(prompt).not.toContain('#FFFFFF');
  });

  it('keeps every other style requirement of the Google template', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image' });

    await generateEmojiImage(GENERATION_INPUT);

    const prompt = String(sdk.imagesGenerateCalls[0]?.prompt);
    for (const line of SHARED_PROMPT_LINES) {
      expect(prompt).toContain(line);
    }
  });

  it('reports promptVersion emoji-image-v1-transparent and a cacheKey built with it', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image' });

    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(result.promptVersion).toBe('emoji-image-v1-transparent');
    expect(result.cacheKey).toBe(OPENAI_CACHE_KEY);
  });

  it('reports promptVersion emoji-image-v1-transparent for a configured OpenAI model too', async () => {
    setEnv({ AI_PROVIDER: 'gpt-image', OPENAI_IMAGE_MODEL: 'gpt-image-1.5' });

    const result = await generateEmojiImage(GENERATION_INPUT);

    expect(result.promptVersion).toBe('emoji-image-v1-transparent');
    expect(result.cacheKey).toBe(OPENAI_CACHE_KEY);
  });
});
