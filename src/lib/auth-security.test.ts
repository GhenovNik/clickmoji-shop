// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getRequestLocale, rateLimitResponse } from './auth-security';

const withHeaders = (headers: Record<string, string>) =>
  new Request('http://localhost/api/x', { headers });

describe('getRequestLocale', () => {
  it('prefers the saved NEXT_LOCALE cookie', () => {
    expect(
      getRequestLocale(withHeaders({ cookie: 'a=1; NEXT_LOCALE=ru', 'accept-language': 'en' }))
    ).toBe('ru');
  });

  it('falls back to the browser languages, then English', () => {
    expect(getRequestLocale(withHeaders({ 'accept-language': 'ru-RU,ru;q=0.9' }))).toBe('ru');
    expect(getRequestLocale(withHeaders({ cookie: 'NEXT_LOCALE=fr' }))).toBe('en');
    expect(getRequestLocale(withHeaders({}))).toBe('en');
  });
});

describe('rateLimitResponse', () => {
  it('answers 429 in the given language', async () => {
    const response = rateLimitResponse(Date.now() + 30_000, 'en');

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(await response.json()).toEqual({ error: 'Too many attempts. Please try again later.' });
  });

  it('keeps the Russian text for callers without a locale', async () => {
    const response = rateLimitResponse(Date.now() + 1000);
    expect(await response.json()).toEqual({ error: 'Слишком много попыток. Попробуйте позже.' });
  });
});
