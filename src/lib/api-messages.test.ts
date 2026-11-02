// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { apiText } from './api-messages';

const request = (cookie: string) => new Request('http://localhost/api/x', { headers: { cookie } });

describe('apiText', () => {
  it('answers in the language of the request', async () => {
    expect(await apiText(request('NEXT_LOCALE=ru'), 'listNotFound')).toBe('Список не найден');
    expect(await apiText(request('NEXT_LOCALE=en'), 'listNotFound')).toBe('List not found');
  });

  it('fills message arguments', async () => {
    expect(await apiText(request('NEXT_LOCALE=ru'), 'tooManyItems', { max: 50 })).toBe(
      'Слишком много товаров (не больше 50 за раз)'
    );
  });

  it('falls back to English outside a request, for code without the request object', async () => {
    expect(await apiText(undefined, 'unauthorized')).toBe('Unauthorized');
  });
});
