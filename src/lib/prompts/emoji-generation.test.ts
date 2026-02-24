import { describe, expect, it } from 'vitest';
import { getEmojiGenerationPrompt } from './emoji-generation';

describe('getEmojiGenerationPrompt', () => {
  it('includes description context when provided', () => {
    const prompt = (getEmojiGenerationPrompt as any)('Apple', 'green sour fruit');

    expect(prompt).toContain('green sour fruit');
  });

  it('works without description', () => {
    const prompt = getEmojiGenerationPrompt('Apple');

    expect(prompt).toContain('Apple');
  });
});
