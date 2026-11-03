import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '@/test/intl';
import ProductsPage from '@/app/categories/[categoryId]/products/page';
import FavoritesPage from '@/app/categories/favorites/page';
import ProductSearch from '@/components/ProductSearch';
import FavoritesSection from '@/components/FavoritesSection';
import AddProductModal from '@/components/products/AddProductModal';

const mocks = vi.hoisted(() => ({
  activeListId: 'list-1' as string | null,
  router: { push: vi.fn(), refresh: vi.fn() },
  params: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useParams: () => ({ categoryId: 'dairy' }),
  useSearchParams: () => mocks.params,
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-1' } }, status: 'authenticated' }),
}));
vi.mock('@/hooks/useListsQuery', () => ({
  listsQueryKey: ['lists'],
  useActiveList: () => ({ activeListId: mocks.activeListId }),
}));

const product = {
  id: 'milk',
  name: 'Молоко',
  nameEn: 'Milk',
  emoji: '🥛',
  isCustom: false,
  imageUrl: null,
  variants: [{ id: 'skimmed', name: 'Обезжиренное', nameEn: 'Skimmed', emoji: '' }],
  category: {
    id: 'dairy',
    name: 'Молочное',
    nameEn: 'Dairy',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
  },
};
const favorite = {
  id: 'favorite-1',
  productId: product.id,
  product,
  variant: product.variants[0],
  usageCount: 1,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let addResponse: () => Promise<Response>;
let createResponse: () => Promise<Response>;
let searchResults: (typeof product)[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.activeListId = 'list-1';
  searchResults = [product];
  addResponse = async () => json({ error: 'Database constraint' }, 500);
  createResponse = async () => json({ product });
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/lists/list-1/items') return addResponse();
    if (url === '/api/products/smart-create') return createResponse();
    if (url.startsWith('/api/search')) return json(searchResults);
    if (url.startsWith('/api/products?')) return json([product]);
    if (url === '/api/favorites') return json(options?.method === 'POST' ? {} : [favorite]);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

function renderUI(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderWithIntl(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, {
    locale: 'en',
  });
}

type Path = 'category' | 'favorites page' | 'search' | 'AI search' | 'favorites section';
const paths: Path[] = ['category', 'favorites page', 'search', 'AI search', 'favorites section'];

async function prepare(path: Path) {
  if (path === 'category') {
    renderUI(<ProductsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Variants/ }));
    fireEvent.click(screen.getByRole('button', { name: /Skimmed/ }));
    return () => screen.getByRole('button', { name: 'Add' });
  }
  if (path === 'favorites page') {
    renderUI(<FavoritesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Skimmed/ }));
    return () => screen.getByRole('button', { name: 'Add' });
  }
  if (path === 'favorites section') {
    renderUI(<FavoritesSection />);
    await screen.findByTitle('Skimmed');
    return () => screen.getByTitle('Skimmed');
  }
  if (path === 'AI search') searchResults = [];
  renderUI(<ProductSearch />);
  fireEvent.change(screen.getByPlaceholderText('Search products...'), {
    target: { value: 'milk' },
  });
  if (path === 'AI search') {
    await screen.findByRole('button', { name: /Create with AI/ });
    return () => screen.getByRole('button', { name: /Create with AI/ });
  }
  await screen.findByText('Milk');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'skimmed' } });
  return () => screen.getByRole('button', { name: /Milk/ });
}

function assertRetained(path: Path) {
  if (path === 'category' || path === 'favorites page') {
    expect(screen.getByText(/Selected: 1/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Skimmed/ })).toBeVisible();
  } else if (path === 'search' || path === 'AI search') {
    expect(screen.getByPlaceholderText('Search products...')).toHaveValue('milk');
    if (path === 'search') expect(screen.getByRole('combobox')).toHaveValue('skimmed');
  } else {
    expect(screen.getByTitle('Skimmed')).toBeEnabled();
  }
}

const listRequests = () =>
  fetchMock.mock.calls.filter(([url]) => url === '/api/lists/list-1/items');

describe.each(paths)('%s list add feedback', (path) => {
  it('shows missing-list validation inline without a request, native alert or navigation', async () => {
    mocks.activeListId = null;
    const button = await prepare(path);
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a shopping list first');
    expect(screen.getByRole('alert')).toBeVisible();
    assertRetained(path);
    expect(listRequests()).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/products/smart-create')).toBe(false);
    expect(window.alert).not.toHaveBeenCalled();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('retains selection after failure, clears feedback on retry and only navigates after success', async () => {
    const button = await prepare(path);
    fireEvent.click(button());
    const error = await screen.findByRole('alert');
    expect(error).toBeVisible();
    expect(error).toHaveTextContent(/Could not add the item/);
    assertRetained(path);
    expect(window.alert).not.toHaveBeenCalled();
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(listRequests()).toHaveLength(1);

    let finish!: (response: Response) => void;
    addResponse = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    fireEvent.click(button());
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.router.push).not.toHaveBeenCalled();
    const body = JSON.parse(listRequests()[1][1].body);
    expect(body.items[0]).toEqual({
      productId: 'milk',
      variantId: path === 'AI search' ? null : 'skimmed',
    });
    await act(async () => {
      finish(json({ createdItems: [{ id: 'item-1' }] }));
    });
    if (path !== 'favorites section') {
      await waitFor(() =>
        expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1')
      );
    } else {
      expect(mocks.router.push).not.toHaveBeenCalled();
    }
    expect(window.alert).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('catalog create feedback (not a list add)', () => {
  it.each([
    { exists: true, customEmojiGenerated: false, text: 'already exists' },
    { exists: false, customEmojiGenerated: true, text: 'has been created' },
    { exists: false, customEmojiGenerated: false, text: 'has been created' },
  ])('shows nonblocking success for $text / custom=$customEmojiGenerated', async (result) => {
    createResponse = async () => json({ ...result, product });
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    renderUI(
      <AddProductModal
        categoryId="dairy"
        categoryName="Dairy"
        isOpen
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'milk' } });
    fireEvent.click(screen.getByRole('button', { name: /Create$/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(result.text);
    expect(screen.getByRole('status')).toBeVisible();
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(product);
    expect(onClose).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
    expect(listRequests()).toHaveLength(0);
    expect(mocks.router.push).not.toHaveBeenCalled();

    let finish!: (response: Response) => void;
    createResponse = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'cream' } });
    fireEvent.click(screen.getByRole('button', { name: /Create$/ }));
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => {
      finish(json({ error: 'Try again' }, 500));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again');
    expect(screen.getByLabelText('Item name')).toHaveValue('cream');
    expect(onClose).not.toHaveBeenCalled();
  });
});
