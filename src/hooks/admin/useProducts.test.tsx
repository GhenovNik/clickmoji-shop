import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { messages } from '@/i18n/messages';
import { useProducts } from './useProducts';

// AGE-1620 AC-2/AC-3: the update/create bodies sent to /api/products must carry
// isCustom/imageUrl/imageUrlEn exactly as the spec demands.

const baseData = {
  name: 'Яблоко',
  nameEn: 'Apple',
  emoji: '🍏',
  categoryId: 'c1',
  imageUrl: 'https://utfs.io/f/old.webp',
  imageUrlEn: 'https://utfs.io/f/old-en.webp' as string | null,
  variants: [],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </NextIntlClientProvider>
    );
  };
}

function stubFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === '/api/products' && (init?.method ?? 'GET') === 'GET') {
        return new Response('[]', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    })
  );
  return calls;
}

function putCalls(calls: Array<{ url: string; init?: RequestInit }>) {
  return calls.filter(({ url, init }) => url === '/api/products/p1' && init?.method === 'PUT');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useProducts update body', () => {
  it('AC-2: unchecking the custom image sends isCustom: false, imageUrl: null, imageUrlEn: null and no deletion request', async () => {
    const calls = stubFetch();
    const { result } = renderHook(() => useProducts(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.updateProduct('p1', { ...baseData, isCustom: false }, undefined);
    });

    const puts = putCalls(calls);
    expect(puts).toHaveLength(1);
    const body = JSON.parse(String(puts[0]!.init?.body));
    expect(body).toMatchObject({ isCustom: false, imageUrl: null, imageUrlEn: null });

    expect(calls.every(({ init }) => (init?.method ?? 'GET') !== 'DELETE')).toBe(true);
    const bodies = calls.map(({ init }) => String(init?.body ?? ''));
    expect(bodies.some((b) => /storage|delete/i.test(b))).toBe(false);
  });

  it('AC-3: keeping the custom image sends the same body as before the change', async () => {
    const calls = stubFetch();
    const { result } = renderHook(() => useProducts(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.updateProduct(
        'p1',
        { ...baseData, isCustom: true },
        'https://utfs.io/f/old.webp'
      );
    });

    const puts = putCalls(calls);
    expect(puts).toHaveLength(1);
    const body = JSON.parse(String(puts[0]!.init?.body));
    expect(body).toMatchObject({
      isCustom: true,
      imageUrl: 'https://utfs.io/f/old.webp',
      imageUrlEn: 'https://utfs.io/f/old-en.webp',
    });
  });

  it('AC-2 (create): creating a product with the checkbox unchecked sends nulls', async () => {
    const calls = stubFetch();
    const { result } = renderHook(() => useProducts(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.createProduct({ ...baseData, isCustom: false }, undefined);
    });

    const posts = calls.filter(
      ({ url, init }) => url === '/api/products' && init?.method === 'POST'
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]!.init?.body));
    expect(body).toMatchObject({ isCustom: false, imageUrl: null, imageUrlEn: null });
  });
});
