// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GET } from './route';

async function search(q: string, locale?: 'ru' | 'en') {
  const response = await GET(
    new Request(`http://localhost/api/emoji/search?q=${encodeURIComponent(q)}`, {
      headers: locale ? { cookie: `NEXT_LOCALE=${locale}` } : {},
    })
  );
  return { status: response.status, body: await response.json() };
}

describe('GET /api/emoji/search', () => {
  it('rejects an empty query', async () => {
    expect((await search('  ')).status).toBe(400);
  });

  it('finds an emoji by its Russian label', async () => {
    const { status, body } = await search('яблоко');

    expect(status).toBe(200);
    expect(body.results.map((r: { emoji: string }) => r.emoji)).toContain('🍎');
  });

  it('returns at most five results with the documented fields', async () => {
    const { body } = await search('сыр');

    expect(body.count).toBe(body.results.length);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(5);
    for (const result of body.results) {
      expect(Object.keys(result).sort()).toEqual(['emoji', 'group', 'label', 'shortcodes']);
    }
  });

  it.each([
    ['ru' as const, 'красное яблоко'],
    ['en' as const, 'red apple'],
  ])('shows the label in the request language (%s), the rest unchanged', async (locale, label) => {
    const { body } = await search('яблоко', locale);
    const apple = body.results.find((r: { emoji: string }) => r.emoji === '🍎');

    expect(apple).toMatchObject({ emoji: '🍎', label });
    expect(Object.keys(apple).sort()).toEqual(['emoji', 'group', 'label', 'shortcodes']);
    expect(body.count).toBe(body.results.length);
  });

  it('returns the same results in the same order in both languages', async () => {
    const ru = await search('сыр', 'ru');
    const en = await search('сыр', 'en');

    const shape = (body: {
      results: Array<{ emoji: string; group: number; shortcodes: string[] }>;
    }) => body.results.map(({ emoji, group, shortcodes }) => ({ emoji, group, shortcodes }));
    expect(shape(en.body)).toEqual(shape(ru.body));
  });
});
