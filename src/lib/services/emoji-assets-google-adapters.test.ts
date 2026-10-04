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
  textPart,
  TINY_PNG_BASE64,
  TINY_PNG_BYTES,
} from '@/test/emoji-image-fixtures';

const sdk = vi.hoisted(() => ({
  constructorCalls: [] as Array<Record<string, unknown>>,
  generateImagesCalls: [] as Array<Record<string, unknown>>,
  generateContentCalls: [] as Array<Record<string, unknown>>,
  generateImagesImpl: (() => undefined) as (params: Record<string, unknown>) => unknown,
  generateContentImpl: (() => undefined) as (params: Record<string, unknown>) => unknown,
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
      generate: async () => {
        throw new Error('OpenAI must not be called in this test');
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

const envSnapshot = snapshotEnv();

function generateWithGoogleModel(model: string) {
  setEnv({ GOOGLE_IMAGE_MODEL: model });
  return generateEmojiImage(GENERATION_INPUT);
}

beforeEach(() => {
  sdk.constructorCalls.length = 0;
  sdk.generateImagesCalls.length = 0;
  sdk.generateContentCalls.length = 0;
  sdk.generateImagesImpl = () => ({
    generatedImages: [{ image: { imageBytes: TINY_PNG_BASE64 } }],
  });
  sdk.generateContentImpl = () => generateContentResponse(candidateWith([imagePart()], 'STOP'));
  // IMAGEN_MODEL differs from every GOOGLE_IMAGE_MODEL used below, so a base run cannot pass by
  // coincidence: the new path must take the model id from GOOGLE_IMAGE_MODEL only.
  setEnv({
    AI_PROVIDER: undefined,
    IMAGEN_MODEL: 'legacy-shim-model',
    GOOGLE_IMAGE_MODEL: undefined,
    OPENAI_IMAGE_MODEL: undefined,
    GOOGLE_GENAI_API_KEY: SYNTHETIC_GOOGLE_KEY,
  });
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

const ACCEPTED_MODELS: Array<{ model: string; adapter: 'generateImages' | 'generateContent' }> = [
  { model: 'imagen-4.0-generate-001', adapter: 'generateImages' },
  { model: 'imagen-4.0-fast-generate-001', adapter: 'generateImages' },
  { model: 'imagen-5.0-generate-preview', adapter: 'generateImages' },
  { model: 'gemini-3.1-flash-image', adapter: 'generateContent' },
  { model: 'gemini-3.1-flash-lite-image', adapter: 'generateContent' },
  { model: 'gemini-2.5-flash-image-preview', adapter: 'generateContent' },
  { model: 'gemini-3-pro-image', adapter: 'generateContent' },
  { model: 'gemini-3.1-flash-image\n', adapter: 'generateContent' },
];

describe('AC-3 Google adapter selection by model id grammar', () => {
  for (const accepted of ACCEPTED_MODELS) {
    it(`routes ${JSON.stringify(accepted.model)} to ${accepted.adapter}`, async () => {
      const result = await generateWithGoogleModel(accepted.model);
      const expectedModel = accepted.model.trim();

      expect(sdk.constructorCalls).toEqual([{ apiKey: SYNTHETIC_GOOGLE_KEY }]);
      if (accepted.adapter === 'generateImages') {
        expect(sdk.generateImagesCalls).toHaveLength(1);
        expect(sdk.generateImagesCalls[0]?.model).toBe(expectedModel);
        expect(sdk.generateContentCalls).toHaveLength(0);
      } else {
        expect(sdk.generateContentCalls).toHaveLength(1);
        expect(sdk.generateContentCalls[0]?.model).toBe(expectedModel);
        expect(sdk.generateImagesCalls).toHaveLength(0);
      }
      expect(result.model).toBe(expectedModel);
    });
  }

  const REJECTED_MODELS = [
    'gemini-image',
    'gemini-imagen',
    'gemini-3.1-flash-noimage',
    'gemini--image',
    'gemini-3.1-flash-image-',
    'models/gemini-3.1-flash-image',
    'Gemini-3.1-Flash-Image',
    'gemini-3.1 flash-image',
    'gemini-3.1-flash-\nimage',
    'gemini-2.5-flash',
    'dall-e-3',
    'foo',
  ];

  for (const rejected of REJECTED_MODELS) {
    it(`rejects ${JSON.stringify(rejected)} with a configuration error before any SDK call`, async () => {
      const generation = generateWithGoogleModel(rejected);

      await expect(generation).rejects.toThrow(/GOOGLE_IMAGE_MODEL/);
      await expect(generation).rejects.toThrow(
        new RegExp(`value "${rejected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
      );
      expect(sdk.constructorCalls).toHaveLength(0);
      expect(sdk.generateImagesCalls).toHaveLength(0);
      expect(sdk.generateContentCalls).toHaveLength(0);
    });
  }
});

describe('AC-4 generateContent request shape and image part selection', () => {
  it('calls generateContent with exactly the documented parameters', async () => {
    await generateWithGoogleModel('gemini-3.1-flash-image');

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateContentCalls[0]).toEqual({
      model: 'gemini-3.1-flash-image',
      contents: getEmojiGenerationPrompt(PRODUCT, DESCRIPTION),
      config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
    });
  });

  it('returns the final image part after text and thought parts', async () => {
    sdk.generateContentImpl = () =>
      generateContentResponse(
        candidateWith([textPart(), imagePart({ thought: true }), imagePart()], 'STOP')
      );

    const result = await generateWithGoogleModel('gemini-3.1-flash-image');

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(result.imageBuffer.equals(TINY_PNG_BYTES)).toBe(true);
  });

  it('returns the first final image part when several are present', async () => {
    const firstPng = Buffer.concat([TINY_PNG_BYTES, Buffer.from([0x01])]).toString('base64');
    sdk.generateContentImpl = () =>
      generateContentResponse(
        candidateWith(
          [imagePart({ inlineData: { mimeType: 'image/png', data: firstPng } }), imagePart()],
          'STOP'
        )
      );

    const result = await generateWithGoogleModel('gemini-3.1-flash-image');

    expect(sdk.generateContentCalls).toHaveLength(1);
    expect(sdk.generateImagesCalls).toHaveLength(0);
    expect(result.imageBuffer.equals(Buffer.concat([TINY_PNG_BYTES, Buffer.from([0x01])]))).toBe(
      true
    );
  });
});

describe('AC-5 generateContent response classification', () => {
  const BLOCKED_FINISH_REASONS = [
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
  ];

  const INCOMPLETE_FINISH_REASONS = [
    'NO_IMAGE',
    'IMAGE_OTHER',
    'MAX_TOKENS',
    'LANGUAGE',
    'OTHER',
    'MALFORMED_FUNCTION_CALL',
    'UNEXPECTED_TOOL_CALL',
    'FINISH_REASON_UNSPECIFIED',
  ];

  it('classifies a response without candidates as blocked-prompt with blockReason', async () => {
    sdk.generateContentImpl = () => ({ promptFeedback: { blockReason: 'SAFETY' } });

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(
      /blocked-prompt.*SAFETY/
    );
  });

  it('classifies an empty candidates array without blockReason as blocked-prompt none', async () => {
    sdk.generateContentImpl = () => ({ candidates: [] });

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(
      /blocked-prompt.*none/
    );
  });

  for (const finishReason of BLOCKED_FINISH_REASONS) {
    it(`classifies finishReason ${finishReason} as blocked even with a valid PNG`, async () => {
      sdk.generateContentImpl = () =>
        generateContentResponse(candidateWith([imagePart()], finishReason));

      await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(
        new RegExp(`blocked.*${finishReason}`)
      );
    });
  }

  for (const finishReason of INCOMPLETE_FINISH_REASONS) {
    it(`classifies finishReason ${finishReason} as incomplete even with a valid PNG`, async () => {
      sdk.generateContentImpl = () =>
        generateContentResponse(candidateWith([imagePart()], finishReason));

      await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(
        new RegExp(`incomplete.*${finishReason}`)
      );
    });
  }

  it('classifies an unknown finishReason as incomplete', async () => {
    sdk.generateContentImpl = () => generateContentResponse(candidateWith([imagePart()], 'WAT'));

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(
      /incomplete.*WAT/
    );
  });

  it('classifies a candidate without content as no-image', async () => {
    sdk.generateContentImpl = () => generateContentResponse({ finishReason: 'STOP' });

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(/no-image/);
  });

  it('classifies a text-only candidate as no-image', async () => {
    sdk.generateContentImpl = () => generateContentResponse(candidateWith([textPart()], 'STOP'));

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(/no-image/);
  });

  it('classifies a thought-only image candidate as no-image', async () => {
    sdk.generateContentImpl = () =>
      generateContentResponse(candidateWith([imagePart({ thought: true })], 'STOP'));

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(/no-image/);
  });

  it('classifies a first final image part with image/jpeg as unsupported-format', async () => {
    sdk.generateContentImpl = () =>
      generateContentResponse(
        candidateWith(
          [
            imagePart({ inlineData: { mimeType: 'image/jpeg', data: TINY_PNG_BASE64 } }),
            imagePart(),
          ],
          'STOP'
        )
      );

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(
      /unsupported-format/
    );
  });

  it('classifies a first final image part without mimeType as unsupported-format', async () => {
    sdk.generateContentImpl = () =>
      generateContentResponse(
        candidateWith([imagePart({ inlineData: { data: TINY_PNG_BASE64 } })], 'STOP')
      );

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(
      /unsupported-format/
    );
  });

  it('classifies empty image data as empty-image', async () => {
    sdk.generateContentImpl = () =>
      generateContentResponse(
        candidateWith([imagePart({ inlineData: { mimeType: 'image/png', data: '' } })], 'STOP')
      );

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(/empty-image/);
  });

  it('classifies base64 data decoding to an empty buffer as empty-image', async () => {
    sdk.generateContentImpl = () =>
      generateContentResponse(
        candidateWith([imagePart({ inlineData: { mimeType: 'image/png', data: '=' } })], 'STOP')
      );

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(/empty-image/);
  });

  it('classifies non-PNG bytes declared as image/png as invalid-png', async () => {
    sdk.generateContentImpl = () =>
      generateContentResponse(
        candidateWith(
          [
            imagePart({
              inlineData: {
                mimeType: 'image/png',
                data: Buffer.from('not a png').toString('base64'),
              },
            }),
          ],
          'STOP'
        )
      );

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(/invalid-png/);
  });

  it('classifies an image larger than 10 MiB as too-large', async () => {
    const oversized = Buffer.concat([TINY_PNG_BYTES, Buffer.alloc(10 * 1024 * 1024)]).toString(
      'base64'
    );
    sdk.generateContentImpl = () =>
      generateContentResponse(
        candidateWith(
          [imagePart({ inlineData: { mimeType: 'image/png', data: oversized } })],
          'STOP'
        )
      );

    await expect(generateWithGoogleModel('gemini-3.1-flash-image')).rejects.toThrow(/too-large/);
  });
});
