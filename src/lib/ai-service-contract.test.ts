import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const serviceRoot = path.join(process.cwd(), 'src/lib/services');
const aiProductsServicePath = path.join(serviceRoot, 'ai-products.ts');
const emojiAssetsServicePath = path.join(serviceRoot, 'emoji-assets.ts');

describe('AI service hardening contract', () => {
  it('routes every runtime text call, including the database CLI, through the retry policy', () => {
    // Do not import/run the database-writing CLI merely to inspect its AI boundary.
    const cli = readFileSync(path.join(process.cwd(), 'scripts/db-products.ts'), 'utf8');
    expect(cli).toContain('await generateGoogleText({ apiKey, prompt })');
    const directCallers = ['src', 'scripts']
      .flatMap((root) =>
        readdirSync(path.join(process.cwd(), root), { recursive: true })
          .filter((file): file is string => typeof file === 'string')
          .filter((file) => /\.(?:ts|tsx|js|mjs)$/.test(file) && !/\.(?:test|spec)\./.test(file))
          .map((file) => path.join(root, file))
      )
      .filter((file) => /\.generateContent\s*\(/.test(readFileSync(file, 'utf8')))
      .sort();
    expect(directCallers).toEqual([
      'src/lib/services/emoji-image-adapters.ts', // Images intentionally retain their own policy.
      'src/lib/services/google-text-generation.ts',
    ]);
  });

  it('keeps AI orchestration behind service boundaries', () => {
    expect(existsSync(aiProductsServicePath)).toBe(true);
    expect(existsSync(emojiAssetsServicePath)).toBe(true);

    const smartCreateRoute = readFileSync(
      path.join(process.cwd(), 'src/app/api/products/smart-create/route.ts'),
      'utf8'
    );

    expect(smartCreateRoute).not.toContain('getAppBaseUrl');
    expect(smartCreateRoute).not.toContain('/api/emoji/generate');
    expect(smartCreateRoute).not.toContain('/api/emoji/upload');
  });

  it('versions emoji prompts and cache keys', async () => {
    const promptModule = await import('./prompts/emoji-generation');

    expect(promptModule.EMOJI_GENERATION_PROMPT_VERSION).toMatch(/^emoji-image-v\d+$/);
    expect(promptModule.getEmojiGenerationCacheKey('  Milk  ', 'cold carton')).toBe(
      `${promptModule.EMOJI_GENERATION_PROMPT_VERSION}:milk:cold carton`
    );
  });

  it('validates smart product AI JSON shape', async () => {
    expect(existsSync(aiProductsServicePath)).toBe(true);
    if (!existsSync(aiProductsServicePath)) return;

    const aiProductsModulePath = './services/ai-products';
    const { parseSmartProductResponse } = await import(/* @vite-ignore */ aiProductsModulePath);

    expect(
      parseSmartProductResponse(
        '```json\n{"nameRu":"Молоко","nameEn":"Milk","categoryName":"Dairy","emoji":"🥛","needsCustomEmoji":false}\n```'
      )
    ).toEqual({
      nameRu: 'Молоко',
      nameEn: 'Milk',
      categoryName: 'Dairy',
      emoji: '🥛',
      needsCustomEmoji: false,
    });

    expect(() => parseSmartProductResponse('{"nameRu":"Молоко"}')).toThrow(
      'Invalid smart product AI response'
    );
  });
});
