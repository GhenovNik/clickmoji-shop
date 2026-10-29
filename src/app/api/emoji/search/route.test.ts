// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GET } from './route';

async function search(q: string) {
  const response = await GET(
    new Request(`http://localhost/api/emoji/search?q=${encodeURIComponent(q)}`)
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
});
