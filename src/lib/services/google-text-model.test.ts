import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GOOGLE_TEXT_MODEL,
  GOOGLE_TEXT_MODEL_ENV,
  resolveGoogleTextModel,
} from '@/lib/services/google-text-model';

const original = process.env[GOOGLE_TEXT_MODEL_ENV];

beforeEach(() => {
  delete process.env[GOOGLE_TEXT_MODEL_ENV];
});

afterEach(() => {
  if (original === undefined) {
    delete process.env[GOOGLE_TEXT_MODEL_ENV];
  } else {
    process.env[GOOGLE_TEXT_MODEL_ENV] = original;
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
  }
});
