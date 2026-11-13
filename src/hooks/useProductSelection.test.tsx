import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { messages } from '@/i18n/messages';
import { useProductSelection, type Product } from './useProductSelection';

// AGE-1618 AC-4..AC-7: a guest's marks are saved before the trip to /login and restored
// once afterwards, only for products that are in the loaded catalogue.
// The stored payload lives under `product-selection:<categoryId>` in sessionStorage.

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));
const auth = vi.hoisted(() => ({
  data: null as { user: { id: string } } | null,
  status: 'unauthenticated' as 'authenticated' | 'unauthenticated',
}));
vi.mock('next-auth/react', () => ({ useSession: () => auth }));

const storageKey = 'product-selection:c1';
const category = {
  id: 'c1',
  name: 'Категория',
  nameEn: 'Category',
  emoji: '🏷️',
  isCustom: false,
  imageUrl: null,
};
const p1: Product = {
  id: 'p1',
  name: 'Молоко',
  nameEn: 'Milk',
  emoji: '🥛',
  isCustom: false,
  imageUrl: null,
  variants: [{ id: 'v1', name: 'Обезжиренное', nameEn: 'Skim', emoji: '' }],
  category,
};
const p2: Product = {
  id: 'p2',
  name: 'Сыр',
  nameEn: 'Cheese',
  emoji: '🧀',
  isCustom: false,
  imageUrl: null,
  variants: [{ id: 'v2', name: 'Копчёный', nameEn: 'Smoked', emoji: '' }],
  category,
};

let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function mount() {
  return renderHook(() => useProductSelection('c1'), { wrapper });
}

beforeEach(() => {
  nav.push.mockReset();
  auth.data = null;
  auth.status = 'unauthenticated';
  window.sessionStorage.clear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/products?categoryId=c1') return Response.json([p1, p2]);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('guest selection saved before sign-in', () => {
  it('restores the saved products and variants once, then removes the key (AC-4, INV-1)', async () => {
    const first = mount();
    await waitFor(() => expect(first.result.current.products).toHaveLength(2));

    act(() => first.result.current.toggleProduct(p1));
    act(() => first.result.current.toggleProduct(p2));
    act(() => first.result.current.selectVariant(p1, 'v1'));
    act(() => first.result.current.saveSelectionForLogin());
    first.unmount();

    const second = mount();
    await waitFor(() =>
      expect(second.result.current.selectedProducts).toEqual(new Set(['p1', 'p2']))
    );
    expect(second.result.current.selectedVariants).toEqual({ p1: 'v1' });
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    second.unmount();
  });

  it('does not select a product that is missing from the catalogue (AC-5)', async () => {
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify({ products: ['p1', 'p9'], variants: { p1: 'v1', p9: 'v9' } })
    );

    const view = mount();
    await waitFor(() => expect(view.result.current.selectedProducts).toEqual(new Set(['p1'])));
    expect(view.result.current.selectedVariants).toEqual({ p1: 'v1' });
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    view.unmount();
  });

  it('restores at most once: a remount after restoration starts empty (AC-6)', async () => {
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify({ products: ['p1'], variants: { p1: 'v1' } })
    );

    const first = mount();
    await waitFor(() => expect(first.result.current.selectedProducts).toEqual(new Set(['p1'])));
    first.unmount();

    const second = mount();
    await waitFor(() => expect(second.result.current.products).toHaveLength(2));
    expect(second.result.current.selectedProducts.size).toBe(0);
    expect(second.result.current.selectedVariants).toEqual({});
    second.unmount();
  });

  it.each([
    ['not JSON', '{oops'],
    ['an array', '[1,2,3]'],
    ['wrong product type', '{"products":"p1","variants":{}}'],
    ['wrong variant type', '{"products":["p1"],"variants":{"p1":123}}'],
    ['a foreign shape', '{"foo":"bar"}'],
  ])('ignores %s in the stored value (AC-7)', async (_label, raw) => {
    window.sessionStorage.setItem(storageKey, raw);

    const view = mount();
    await waitFor(() => expect(view.result.current.products).toHaveLength(2));
    expect(view.result.current.selectedProducts.size).toBe(0);
    expect(view.result.current.selectedVariants).toEqual({});
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    view.unmount();
  });

  it('ignores the stored value when sessionStorage throws (AC-7)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });

    const view = mount();
    await waitFor(() => expect(view.result.current.products).toHaveLength(2));
    expect(view.result.current.selectedProducts.size).toBe(0);
    expect(view.result.current.selectedVariants).toEqual({});
    view.unmount();
  });

  it('saves without throwing when sessionStorage is unavailable (AC-7)', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });

    const view = mount();
    await waitFor(() => expect(view.result.current.products).toHaveLength(2));
    expect(() => view.result.current.saveSelectionForLogin()).not.toThrow();
    view.unmount();
  });
});
