import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '@/test/intl';

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
});
