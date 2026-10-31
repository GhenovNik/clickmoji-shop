import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GOOGLE_TEXT_MODEL, GOOGLE_TEXT_MODEL_ENV } from '@/lib/services/google-text-model';

const sdk = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  responseText: '',
  error: undefined as Error | undefined,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class GoogleGenAIDouble {
    models = {
      generateContent: async (params: Record<string, unknown>) => {
        sdk.calls.push(params);
        if (sdk.error) throw sdk.error;
        return { text: sdk.responseText };
      },
    };
  },
}));

const {
  analyzeSmartProduct,
  buildBulkProductsPrompt,
  buildSmartProductPrompt,
  processProductBatch,
  parseShoppingListText,
} = await import('./ai-products');

const CATEGORIES = [{ id: 'cat-1', name: 'Молочное', nameEn: 'Dairy' }];

const SMART_RESPONSE =
  '{"nameRu":"Молоко","nameEn":"Milk","categoryName":"Dairy","emoji":"🥛","needsCustomEmoji":false}';
const BULK_RESPONSE = '[{"nameRu":"Молоко","nameEn":"Milk","categoryName":"Dairy","emoji":"🥛"}]';
const LIST_RESPONSE =
  '[{"nameRu":"Молоко","nameEn":"Milk","categoryName":"Dairy","emoji":"🥛","note":"2L"}]';

const SERVICES = [
  {
    name: 'analyzeSmartProduct',
    responseText: SMART_RESPONSE,
    run: () =>
      analyzeSmartProduct({
        apiKey: 'synthetic-key',
        productName: 'Milk',
        categories: CATEGORIES,
      }),
  },
  {
    name: 'processProductBatch',
    responseText: BULK_RESPONSE,
    run: () =>
      processProductBatch({
        apiKey: 'synthetic-key',
        productNames: ['Milk'],
        categories: CATEGORIES,
      }),
  },
  {
    name: 'parseShoppingListText',
    responseText: LIST_RESPONSE,
    run: () =>
      parseShoppingListText({
        apiKey: 'synthetic-key',
        text: 'Milk 2L',
        categories: CATEGORIES,
      }),
  },
];

const original = process.env[GOOGLE_TEXT_MODEL_ENV];

beforeEach(() => {
  sdk.calls.length = 0;
  sdk.error = undefined;
  delete process.env[GOOGLE_TEXT_MODEL_ENV];
});

afterEach(() => {
  if (original === undefined) {
    delete process.env[GOOGLE_TEXT_MODEL_ENV];
  } else {
    process.env[GOOGLE_TEXT_MODEL_ENV] = original;
  }
});

describe('text services pass the resolved model to the SDK', () => {
  for (const service of SERVICES) {
    it(`${service.name} uses GOOGLE_TEXT_MODEL and requests JSON output`, async () => {
      process.env[GOOGLE_TEXT_MODEL_ENV] = 'gemini-3.8-flash';
      sdk.responseText = service.responseText;

      const result = await service.run();

      expect(sdk.calls).toHaveLength(1);
      expect(sdk.calls[0]?.model).toBe('gemini-3.8-flash');
      expect(sdk.calls[0]?.config).toEqual({ responseMimeType: 'application/json' });
      expect(result.model).toBe('gemini-3.8-flash');
    });

    it(`${service.name} falls back to the default model`, async () => {
      sdk.responseText = service.responseText;

      const result = await service.run();

      expect(sdk.calls).toHaveLength(1);
      expect(sdk.calls[0]?.model).toBe(DEFAULT_GOOGLE_TEXT_MODEL);
      expect(result.model).toBe(DEFAULT_GOOGLE_TEXT_MODEL);
    });

    it(`${service.name} rejects an image model before any SDK call`, async () => {
      process.env[GOOGLE_TEXT_MODEL_ENV] = 'gemini-3.1-flash-image';
      sdk.responseText = service.responseText;

      await expect(service.run()).rejects.toThrow(GOOGLE_TEXT_MODEL_ENV);
      expect(sdk.calls).toHaveLength(0);
    });
  }

  it('smart-create keeps a Russian name instead of translating it to English and back', () => {
    const prompt = buildSmartProductPrompt({
      productName: 'сливки 33%',
      categories: CATEGORIES,
    });

    expect(prompt).not.toMatch(/translate the product name to russian/i);
    expect(prompt).toContain('never translate Russian to English and back');
    expect(prompt).toContain('Dairy (Молочное) — milk, cream, sour cream');
  });

  it('bulk import keeps a Russian name instead of translating it to English and back', () => {
    const prompt = buildBulkProductsPrompt({
      productNames: ['сливки 33%'],
      categories: CATEGORIES,
    });

    expect(prompt).not.toMatch(/translate each product/i);
    expect(prompt).toContain('never translate Russian to English and back');
    expect(prompt).toContain('Dairy (Молочное) — milk, cream, sour cream');
  });

  it('propagates an SDK failure without a second call', async () => {
    sdk.error = new Error('synthetic provider failure');
    sdk.responseText = SMART_RESPONSE;

    await expect(
      analyzeSmartProduct({
        apiKey: 'synthetic-key',
        productName: 'Milk',
        categories: CATEGORIES,
      })
    ).rejects.toThrow('synthetic provider failure');
    expect(sdk.calls).toHaveLength(1);
  });
});
