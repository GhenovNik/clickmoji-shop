import { test, expect } from '@playwright/test';

test.describe('Emoji API', () => {
  test('GET /api/emoji/search without query returns 400', async ({ request }) => {
    const response = await request.get('/api/emoji/search');
    expect(response.status()).toBe(400);
  });

  test('GET /api/emoji/search returns results for query', async ({ request }) => {
    const response = await request.get('/api/emoji/search?q=smile');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.query).toBe('smile');
    expect(Array.isArray(data.results)).toBe(true);
    expect(typeof data.count).toBe('number');
    expect(data.count).toBe(data.results.length);
  });

  test('POST /api/emoji/generate returns 401 when unauthenticated', async ({ request }) => {
    const response = await request.post('/api/emoji/generate', {
      data: { productName: 'Test Product' },
    });
    expect(response.status()).toBe(401);
  });
});
