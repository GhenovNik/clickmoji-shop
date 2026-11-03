import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GOOGLE_TEXT_MODEL,
  GOOGLE_TEXT_MODEL_ENV,
  GOOGLE_TEXT_MODEL_FALLBACK_ENV,
  GoogleTextModelConfigurationError,
  resolveGoogleTextModel,
  resolveGoogleTextModelFallback,
} from '@/lib/services/google-text-model';
import { analyzeSmartProduct, parseShoppingListText, processProductBatch } from './ai-products';

const sdk = vi.hoisted(() => ({ constructor: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      sdk.constructor();
      throw new Error('SDK must not be constructed for invalid configuration');
    }
  },
}));

const original = process.env[GOOGLE_TEXT_MODEL_ENV];
const originalFallback = process.env[GOOGLE_TEXT_MODEL_FALLBACK_ENV];

beforeEach(() => {
  delete process.env[GOOGLE_TEXT_MODEL_ENV];
  delete process.env[GOOGLE_TEXT_MODEL_FALLBACK_ENV];
  sdk.constructor.mockClear();
});

afterEach(() => {
  if (original === undefined) {
    delete process.env[GOOGLE_TEXT_MODEL_ENV];
  } else {
    process.env[GOOGLE_TEXT_MODEL_ENV] = original;
  }
  if (originalFallback === undefined) {
    delete process.env[GOOGLE_TEXT_MODEL_FALLBACK_ENV];
  } else {
    process.env[GOOGLE_TEXT_MODEL_FALLBACK_ENV] = originalFallback;
  }
});

describe('resolveGoogleTextModel', () => {
  it('uses the default when the variable is unset, empty or whitespace', () => {
    expect(DEFAULT_GOOGLE_TEXT_MODEL).toBe('gemini-3.8-flash');

    expect(resolveGoogleTextModel()).toBe(DEFAULT_GOOGLE_TEXT_MODEL);
    process.env[GOOGLE_TEXT_MODEL_ENV] = '';
    expect(resolveGoogleTextModel()).toBe(DEFAULT_GOOGLE_TEXT_MODEL);
    process.env[GOOGLE_TEXT_MODEL_ENV] = '  \n\t ';
    expect(resolveGoogleTextModel()).toBe(DEFAULT_GOOGLE_TEXT_MODEL);
  });

  it('returns the trimmed override', () => {
    process.env[GOOGLE_TEXT_MODEL_ENV] = '  gemini-3.8-flash\n';
    expect(resolveGoogleTextModel()).toBe('gemini-3.8-flash');
  });

  const rejected = [
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite-image',
    'gemini-3.1-flash-image-preview',
    'imagen-4.0-generate-001',
    'gpt-image-2.5-flare',
    'models/gemini-3.5-flash',
    'Gemini-3.5-Flash',
    'gemini-3.5 flash',
    'gemini-3.5-flash\nfoo',
    'gemini--flash',
    'foo',
  ];

  for (const value of rejected) {
    it(`rejects ${JSON.stringify(value)} naming the variable and its value`, () => {
      process.env[GOOGLE_TEXT_MODEL_ENV] = value;

      expect(() => resolveGoogleTextModel()).toThrow(GOOGLE_TEXT_MODEL_ENV);
      expect(() => resolveGoogleTextModel()).toThrow(`value "${value.trim()}"`);
    });

    it(`rejects the same unsupported fallback: ${JSON.stringify(value)}`, () => {
      process.env[GOOGLE_TEXT_MODEL_FALLBACK_ENV] = value;

      expect(() => resolveGoogleTextModelFallback()).toThrow(GOOGLE_TEXT_MODEL_FALLBACK_ENV);
      expect(() => resolveGoogleTextModelFallback()).toThrow(`value "${value.trim()}"`);
    });
  }
});

describe('resolveGoogleTextModelFallback', () => {
  it.each([undefined, '', '  \n\t '])('does not enable a fallback for %s', (value) => {
    if (value !== undefined) process.env[GOOGLE_TEXT_MODEL_FALLBACK_ENV] = value;
    expect(resolveGoogleTextModelFallback()).toBeUndefined();
  });

  it('trims the fallback independently of the primary', () => {
    process.env[GOOGLE_TEXT_MODEL_ENV] = 'gemini-3.8-flash';
    process.env[GOOGLE_TEXT_MODEL_FALLBACK_ENV] = '  gemini-2.5-flash\n';
    expect(resolveGoogleTextModelFallback()).toBe('gemini-2.5-flash');
    expect(resolveGoogleTextModel()).toBe('gemini-3.8-flash');
  });

  const services = [
    () => analyzeSmartProduct({ apiKey: 'synthetic', productName: 'Milk', categories: [] }),
    () => processProductBatch({ apiKey: 'synthetic', productNames: ['Milk'], categories: [] }),
    () => parseShoppingListText({ apiKey: 'synthetic', text: 'Milk', categories: [] }),
  ];

  it.each(services)('rejects an invalid fallback before creating any SDK client', async (run) => {
    process.env[GOOGLE_TEXT_MODEL_FALLBACK_ENV] = 'gemini-3.1-flash-image';
    await expect(run()).rejects.toBeInstanceOf(GoogleTextModelConfigurationError);
    await expect(run()).rejects.toMatchObject({ env: GOOGLE_TEXT_MODEL_FALLBACK_ENV });
    expect(sdk.constructor).not.toHaveBeenCalled();
  });
});
