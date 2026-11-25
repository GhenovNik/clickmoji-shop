import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '@/test/intl';
import { queryKeys } from '@/lib/query-keys';

// Search results show the product, its category and its variants in the active language.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-1' } }, status: 'authenticated' }),
}));

const { default: ProductSearch } = await import('@/components/ProductSearch');

const result = {
  id: 'milk',
  name: 'Молоко',
  nameEn: 'Milk',
  emoji: '🥛',
  isCustom: true,
  imageUrl: '/uploads/milk-ru.png',
  imageUrlEn: '/uploads/milk-en.png',
  variants: [{ id: 'v-1', name: 'Обезжиренное', nameEn: 'Skimmed', emoji: '' }],
  category: {
    id: 'dairy',
    name: 'Молочное',
    nameEn: 'Dairy',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
  },
};

function mockSearch(products: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/search')) return new Response(JSON.stringify(products));
      if (url === '/api/lists') return new Response(JSON.stringify([]));
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

function mockCreateFailure(answer: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/search')) return new Response(JSON.stringify([]));
      if (url === '/api/lists') {
        return new Response(
          JSON.stringify([
            {
              id: 'list-1',
              name: 'Список',
              isActive: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              _count: { items: 0 },
            },
          ])
        );
      }
      if (url === '/api/products/smart-create') return answer;
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

function renderSearch(locale: 'ru' | 'en') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderWithIntl(
    <Wrapper>
      <ProductSearch />
    </Wrapper>,
    { locale }
  );
}

const pictureSrc = (alt: string) =>
  decodeURIComponent(screen.getByRole('img', { name: alt }).getAttribute('src') ?? '');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('product search', () => {
  it('shows a result with its English name, category, variant and picture in English', async () => {
    mockSearch([result]);
    renderSearch('en');

    fireEvent.change(screen.getByPlaceholderText('Search products...'), {
      target: { value: 'milk' },
    });

    expect(await screen.findByText('Milk')).toBeTruthy();
    expect(screen.getByText('Dairy')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Skimmed' })).toBeTruthy();
    expect(screen.queryByText('Молоко')).toBeNull();
    expect(pictureSrc('Milk')).toContain('milk-en.png');
  });

  it('keeps the main picture in English when there is no English one', async () => {
    mockSearch([{ ...result, imageUrlEn: undefined }]);
    renderSearch('en');

    fireEvent.change(screen.getByPlaceholderText('Search products...'), {
      target: { value: 'milk' },
    });

    expect(await screen.findByText('Milk')).toBeTruthy();
    expect(pictureSrc('Milk')).toContain('milk-ru.png');
  });

  it('shows the Russian copy and names in Russian', async () => {
    mockSearch([]);
    renderSearch('ru');

    fireEvent.change(screen.getByPlaceholderText('Поиск товаров...'), {
      target: { value: 'тархун' },
    });

    expect(await screen.findByText('Ничего не найдено')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Создать через AI/ })).toBeTruthy();
  });

  it('shows the localized failure when the AI create answer is not JSON', async () => {
    mockCreateFailure(new Response('<html>Bad gateway</html>', { status: 500 }));
    renderSearch('ru');

    fireEvent.change(screen.getByPlaceholderText('Поиск товаров...'), {
      target: { value: 'сметана' },
    });
    fireEvent.click((await screen.findAllByRole('button', { name: /Создать через AI/ }))[0]);

    expect(await screen.findByText(/Ошибка при создании товара/)).toBeTruthy();
    expect(screen.queryByText(/valid JSON/)).toBeNull();
  });

  it('shows the server message for a failed AI create in the request language', async () => {
    mockCreateFailure(
      new Response(JSON.stringify({ error: 'Нет категорий. Обратитесь к администратору.' }), {
        status: 400,
      })
    );
    renderSearch('ru');

    fireEvent.change(screen.getByPlaceholderText('Поиск товаров...'), {
      target: { value: 'сметана' },
    });
    fireEvent.click((await screen.findAllByRole('button', { name: /Создать через AI/ }))[0]);

    expect(await screen.findByText('Нет категорий. Обратитесь к администратору.')).toBeTruthy();
  });

  it('asks for and caches results per interface language', async () => {
    mockSearch([]);
    renderSearch('en');

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'milk' } });
    await screen.findByText(/nothing found/i);

    const searchUrls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/search'));
    expect(searchUrls.at(-1)).toBe('/api/search?q=milk&locale=en');
    expect(queryKeys.searchQuery('milk', 'en')).not.toEqual(queryKeys.searchQuery('milk', 'ru'));
  });
});
