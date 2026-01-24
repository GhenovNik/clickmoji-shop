import { test, expect } from '@playwright/test';

test.describe('Public API endpoints', () => {
  test('GET /api/categories returns array', async ({ request }) => {
    const response = await request.get('/api/categories');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('GET /api/products returns array', async ({ request }) => {
    const response = await request.get('/api/products');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('GET /api/products?categoryId=... returns array when categories exist', async ({
    request,
  }) => {
    const categoriesResponse = await request.get('/api/categories');
    expect(categoriesResponse.ok()).toBeTruthy();

    const categories = await categoriesResponse.json();
    if (!Array.isArray(categories) || categories.length === 0) {
      test.skip();
    }

    const categoryId = categories[0].id as string;
    const response = await request.get(`/api/products?categoryId=${categoryId}`);
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('GET /api/search returns array for empty query', async ({ request }) => {
    const response = await request.get('/api/search?q=');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });
});
