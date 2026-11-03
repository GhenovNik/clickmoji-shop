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
let products: (typeof product)[];
let favorites: Array<Omit<typeof favorite, 'variant'> & { variant?: typeof favorite.variant }>;
let usageResponse: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.router.refresh.mockReset();
  mocks.activeListId = 'list-1';
  searchResults = [product];
  products = [product];
  favorites = [favorite];
  usageResponse = async () => json({});
  addResponse = async () => json({ error: 'Database constraint' }, 500);
  createResponse = async () => json({ product });
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (/^\/api\/lists\/list-[12]\/items$/.test(url)) return addResponse();
    if (url === '/api/products/smart-create') return createResponse();
    if (url.startsWith('/api/search')) return json(searchResults);
    if (url.startsWith('/api/products?')) return json(products);
    if (url === '/api/favorites')
      return options?.method === 'POST' ? usageResponse() : json(favorites);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

function renderUI(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = renderWithIntl(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, {
    locale: 'en',
  });
  return {
    ...view,
    client,
    rerenderUI: (next: React.ReactElement) =>
      view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
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
    return () => screen.getByRole('button', { name: /Create with AI|Retry list add/ });
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
    expect(error).toHaveTextContent(
      path === 'AI search'
        ? /created in the catalog.*could not be added to the list/
        : /Could not add the item/
    );
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

const usageRequests = () =>
  fetchMock.mock.calls.filter(
    ([url, options]) => url === '/api/favorites' && options?.method === 'POST'
  );
const createRequests = () =>
  fetchMock.mock.calls.filter(([url]) => url === '/api/products/smart-create');
const allListRequests = () =>
  fetchMock.mock.calls.filter(([url]) => /^\/api\/lists\/list-[12]\/items$/.test(url));
const bodyOf = (call: (typeof fetchMock.mock.calls)[number]) => JSON.parse(call[1].body);

function deferredResponse() {
  let finish!: (response: Response) => void;
  let fail!: (error: Error) => void;
  const response = new Promise<Response>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { response: () => response, finish: (value: Response) => finish(value), fail };
}

const cream = { ...product, id: 'cream', name: 'Сливки', nameEn: 'Cream', variants: [] };
const creamFavorite = {
  ...favorite,
  id: 'favorite-2',
  productId: cream.id,
  product: cream,
  variant: undefined,
};

describe('favorite add and usage are separate completed operations', () => {
  it('settles A success without clearing B pending feedback or creating an item retry', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    addResponse = first.response;
    const view = renderUI(<FavoritesSection />);
    fireEvent.click(await screen.findByTitle('Skimmed'));
    await waitFor(() => expect(allListRequests()).toHaveLength(1));
    mocks.activeListId = 'list-2';
    view.rerenderUI(<FavoritesSection />);
    addResponse = second.response;
    fireEvent.click(screen.getByTitle('Skimmed'));
    await waitFor(() => expect(allListRequests()).toHaveLength(2));
    await act(async () => first.finish(json({ createdItems: [{ id: 'item-1' }] })));
    expect(screen.getByTitle('Skimmed')).toBeDisabled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry usage update' })).toBeNull();
    await act(async () => second.finish(json({ createdItems: [{ id: 'item-2' }] })));
    expect(await screen.findByRole('status')).toHaveTextContent('Item added to the list');
    mocks.activeListId = 'list-1';
    view.rerenderUI(<FavoritesSection />);
    expect(screen.getByRole('status')).toHaveTextContent('Item added to the list');
    expect(screen.getByTitle('Skimmed')).toBeEnabled();
    expect(allListRequests().map(([url]) => url)).toEqual([
      '/api/lists/list-1/items',
      '/api/lists/list-2/items',
    ]);
    expect(usageRequests()).toHaveLength(2);
  });

  it('keeps the target guarded while the original usage update is pending and retains unresolved usage after a deliberate duplicate', async () => {
    addResponse = async () => json({ createdItems: [{ id: 'item-1' }] });
    const pending = deferredResponse();
    usageResponse = pending.response;
    renderUI(<FavoritesSection />);
    const add = await screen.findByTitle('Skimmed');
    fireEvent.click(add);
    await waitFor(() => expect(usageRequests()).toHaveLength(1));
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(listRequests()).toHaveLength(1);
    await act(async () => pending.finish(json({}, 500)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Item was added');
    expect(add).toBeEnabled();
    usageResponse = async () => json({});
    fireEvent.click(add);
    await waitFor(() => expect(usageRequests()).toHaveLength(2));
    await waitFor(() => expect(add).toBeEnabled());
    expect(listRequests()).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('usage update failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry usage update' }));
    await waitFor(() => expect(usageRequests()).toHaveLength(3));
    expect(await screen.findByRole('status')).toHaveTextContent('Favorite usage updated');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(listRequests()).toHaveLength(2);
    expect(usageRequests().map(bodyOf)).toEqual(Array(3).fill({ variantId: 'skimmed' }));
  });

  it('reports the completed add, retries only usage after repeated failures, and still permits a deliberate duplicate', async () => {
    addResponse = async () => json({ createdItems: [{ id: 'item-1' }] });
    usageResponse = async () => json({ error: 'Usage unavailable' }, 500);
    renderUI(<FavoritesSection />);
    const add = await screen.findByTitle('Skimmed');
    fireEvent.click(add);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Item was added to the list, but the favorite usage update failed'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Could not add');
    expect(listRequests()).toHaveLength(1);
    expect(bodyOf(listRequests()[0])).toEqual({
      items: [{ productId: 'milk', variantId: 'skimmed' }],
    });
    expect(usageRequests()).toHaveLength(1);
    expect(bodyOf(usageRequests()[0])).toEqual({ variantId: 'skimmed' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry usage update' }));
    await waitFor(() => expect(usageRequests()).toHaveLength(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('Item was added');
    expect(listRequests()).toHaveLength(1);

    const pending = deferredResponse();
    usageResponse = pending.response;
    const retry = screen.getByRole('button', { name: 'Retry usage update' });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await waitFor(() => expect(usageRequests()).toHaveLength(3));
    expect(retry).toBeDisabled();
    expect(add).toBeDisabled();
    await act(async () => pending.finish(json({})));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Item added to the list. Favorite usage updated'
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry usage update' })).toBeNull();
    expect(usageRequests().map(bodyOf)).toEqual([
      { variantId: 'skimmed' },
      { variantId: 'skimmed' },
      { variantId: 'skimmed' },
    ]);
    expect(listRequests()).toHaveLength(1);
    usageResponse = async () => json({});
    fireEvent.click(add);
    await waitFor(() => expect(usageRequests()).toHaveLength(4));
    expect(listRequests()).toHaveLength(2);
    expect(bodyOf(listRequests()[1])).toEqual(bodyOf(listRequests()[0]));
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('guards reentrant taps through both steps and scopes pending/retry to list and favorite', async () => {
    favorites = [favorite, creamFavorite];
    const pending = deferredResponse();
    addResponse = pending.response;
    usageResponse = async () => json({}, 500);
    const view = renderUI(<FavoritesSection />);
    const add = await screen.findByTitle('Skimmed');
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await waitFor(() => expect(listRequests()).toHaveLength(1));
    expect(add).toBeDisabled();
    mocks.activeListId = 'list-2';
    view.rerenderUI(<FavoritesSection />);
    expect(screen.getByTitle('Skimmed')).toBeEnabled();
    await act(async () => pending.finish(json({ createdItems: [{ id: 'item-1' }] })));
    await waitFor(() => expect(usageRequests()).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry usage update' })).toBeNull();
    addResponse = async () => json({ createdItems: [{ id: 'item-2' }] });
    usageResponse = async () => json({});
    fireEvent.click(screen.getByTitle('Cream'));
    await waitFor(() => expect(usageRequests()).toHaveLength(2));
    expect(allListRequests().map(([url]) => url)).toEqual([
      '/api/lists/list-1/items',
      '/api/lists/list-2/items',
    ]);
    expect(bodyOf(allListRequests()[1])).toEqual({
      items: [{ productId: 'cream', variantId: null }],
    });
    mocks.activeListId = 'list-1';
    view.rerenderUI(<FavoritesSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry usage update' }));
    await waitFor(() => expect(usageRequests()).toHaveLength(3));
    expect(bodyOf(usageRequests()[2])).toEqual({ variantId: 'skimmed' });
    expect(allListRequests()).toHaveLength(2);
  });
});

describe.each(['category', 'favorites page'] as const)('%s atomic multi-item operation', (path) => {
  it('retains the entire valid batch on failure and retries the whole batch exactly once', async () => {
    products = [product, cream];
    favorites = [favorite, creamFavorite];
    const button = await prepare(path);
    fireEvent.click(screen.getByRole('button', { name: /Cream/ }));
    expect(screen.getByText(/Selected: 2/)).toBeVisible();
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add the items');
    expect(screen.getByText(/Selected: 2/)).toBeVisible();
    const expected = {
      items: [
        { productId: 'milk', variantId: 'skimmed' },
        { productId: 'cream', variantId: null },
      ],
    };
    expect(listRequests().map(bodyOf)).toEqual([expected]);
    expect(mocks.router.push).not.toHaveBeenCalled();
    const pending = deferredResponse();
    addResponse = pending.response;
    const add = button();
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(listRequests().map(bodyOf)).toEqual([expected, expected]);
    expect(add).toBeDisabled();
    await act(async () =>
      pending.finish(json({ createdItems: [{ id: 'item-1' }, { id: 'item-2' }] }))
    );
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1'));
    expect(screen.queryByText(/Selected:/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(listRequests()).toHaveLength(2);
    expect(usageRequests()).toHaveLength(0);
  });
});

describe('AI completed operation ownership', () => {
  async function startPendingAdd() {
    searchResults = [];
    const view = renderUI(<ProductSearch />);
    fireEvent.change(screen.getByPlaceholderText('Search products...'), {
      target: { value: 'milk' },
    });
    const pending = deferredResponse();
    addResponse = pending.response;
    fireEvent.click(await screen.findByRole('button', { name: /Create with AI/ }));
    await waitFor(() => expect(allListRequests()).toHaveLength(1));
    return { view, pending };
  }

  it.each([false, true])(
    'records successful A add despite obsolete UI (A→B→A before response: %s)',
    async (roundTrip) => {
      const { view, pending } = await startPendingAdd();
      mocks.activeListId = 'list-2';
      view.rerenderUI(<ProductSearch />);
      if (roundTrip) {
        mocks.activeListId = 'list-1';
        view.rerenderUI(<ProductSearch />);
      }
      await act(async () => pending.finish(json({ createdItems: [{ id: 'item-1' }] })));
      mocks.activeListId = 'list-1';
      view.rerenderUI(<ProductSearch />);
      expect(mocks.router.push).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText('Search products...')).toHaveValue('milk');
      expect(createRequests()).toHaveLength(1);
      expect(allListRequests()).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Retry list add' })).toBeNull();
    }
  );

  it('never labels a pending item POST as a failed retry', async () => {
    const { pending } = await startPendingAdd();
    expect(screen.queryByRole('button', { name: 'Retry list add' })).toBeNull();
    await act(async () => pending.finish(json({ createdItems: [{ id: 'item-1' }] })));
  });

  it.each([
    ['500', false],
    ['500', true],
    ['abort', false],
    ['abort', true],
  ] as const)(
    'retains failed add-only retry after %s (A→B→A before response: %s)',
    async (failure, roundTrip) => {
      const { view, pending } = await startPendingAdd();
      mocks.activeListId = 'list-2';
      view.rerenderUI(<ProductSearch />);
      if (roundTrip) {
        mocks.activeListId = 'list-1';
        view.rerenderUI(<ProductSearch />);
      }
      await act(async () => {
        if (failure === 'abort') pending.fail(new DOMException('Aborted', 'AbortError'));
        else pending.finish(json({ error: 'Unavailable' }, 500));
      });
      expect(mocks.router.push).not.toHaveBeenCalled();
      mocks.activeListId = 'list-1';
      view.rerenderUI(<ProductSearch />);
      const retry = screen.getByRole('button', { name: 'Retry list add' });
      expect(retry).toBeEnabled();
      addResponse = async () => json({ createdItems: [{ id: 'item-1' }] });
      fireEvent.click(retry);
      await waitFor(() =>
        expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1')
      );
      expect(createRequests().map(bodyOf)).toEqual([{ productName: 'milk' }]);
      expect(allListRequests().map(([url]) => url)).toEqual([
        '/api/lists/list-1/items',
        '/api/lists/list-1/items',
      ]);
      expect(allListRequests().map(bodyOf)).toEqual(
        Array(2).fill({ items: [{ productId: 'milk', variantId: null }] })
      );
      expect(screen.queryByRole('button', { name: 'Retry list add' })).toBeNull();
    }
  );

  it('keeps a newer operation pending and then retries only its failed add', async () => {
    const { view, pending } = await startPendingAdd();
    mocks.activeListId = 'list-2';
    fireEvent.change(screen.getByPlaceholderText('Search products...'), {
      target: { value: 'cream' },
    });
    view.rerenderUI(<ProductSearch />);
    // The component intentionally serializes operations, even across target changes.
    const create = await screen.findByRole('button', { name: /Creating/ });
    expect(create).toBeDisabled();
    fireEvent.click(create);
    expect(createRequests()).toHaveLength(1);
    await act(async () => pending.finish(json({ createdItems: [{ id: 'item-1' }] })));
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Search products...')).toHaveValue('cream');
    const newer = deferredResponse();
    createResponse = async () => json({ product: cream });
    addResponse = newer.response;
    fireEvent.click(await screen.findByRole('button', { name: /Create with AI/ }));
    await waitFor(() => expect(allListRequests()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Retry list add' })).toBeNull();
    await act(async () => newer.finish(json({ error: 'Unavailable' }, 500)));
    addResponse = async () => json({ createdItems: [{ id: 'item-2' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry list add' }));
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-2'));
    expect(createRequests().map(bodyOf)).toEqual([
      { productName: 'milk' },
      { productName: 'cream' },
    ]);
    expect(allListRequests().map(([url]) => url)).toEqual([
      '/api/lists/list-1/items',
      '/api/lists/list-2/items',
      '/api/lists/list-2/items',
    ]);
    expect(allListRequests().map(bodyOf)).toEqual([
      { items: [{ productId: 'milk', variantId: null }] },
      { items: [{ productId: 'cream', variantId: null }] },
      { items: [{ productId: 'cream', variantId: null }] },
    ]);
  });
});

describe('AI catalog create followed by list add', () => {
  it('does not claim a new catalog create when smart-create found an existing product', async () => {
    createResponse = async () => json({ product, exists: true });
    const button = await prepare('AI search');
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'already exists in the catalog, but could not be added to the list'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('was created');
    addResponse = async () => json({ createdItems: [{ id: 'item-1' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry list add' }));
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1'));
    expect(createRequests().map(bodyOf)).toEqual([{ productName: 'milk' }]);
    expect(listRequests().map(bodyOf)).toEqual(
      Array(2).fill({ items: [{ productId: 'milk', variantId: null }] })
    );
  });

  it('retries creation only when creation itself failed, without pretending a catalog product exists', async () => {
    createResponse = async () => json({ error: 'AI unavailable' }, 500);
    const button = await prepare('AI search');
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('AI unavailable');
    expect(listRequests()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Retry list add' })).toBeNull();
    createResponse = async () => json({ product });
    addResponse = async () => json({ createdItems: [{ id: 'item-1' }] });
    fireEvent.click(button());
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1'));
    expect(createRequests().map(bodyOf)).toEqual([
      { productName: 'milk' },
      { productName: 'milk' },
    ]);
    expect(listRequests().map(bodyOf)).toEqual([
      { items: [{ productId: 'milk', variantId: null }] },
    ]);
  });

  it('keeps an in-flight list add bound to its original list and hides its retry on another list', async () => {
    searchResults = [];
    const view = renderUI(<ProductSearch />);
    fireEvent.change(screen.getByPlaceholderText('Search products...'), {
      target: { value: 'milk' },
    });
    const pending = deferredResponse();
    addResponse = pending.response;
    fireEvent.click(await screen.findByRole('button', { name: /Create with AI/ }));
    await waitFor(() => expect(listRequests()).toHaveLength(1));
    mocks.activeListId = 'list-2';
    view.rerenderUI(<ProductSearch />);
    await act(async () => pending.finish(json({ error: 'Unavailable' }, 500)));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry list add' })).toBeNull();
    expect(allListRequests()).toHaveLength(1);
    expect(mocks.router.push).not.toHaveBeenCalled();
    mocks.activeListId = 'list-1';
    view.rerenderUI(<ProductSearch />);
    addResponse = async () => json({ createdItems: [{ id: 'item-1' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry list add' }));
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1'));
    expect(allListRequests().map(([url]) => url)).toEqual([
      '/api/lists/list-1/items',
      '/api/lists/list-1/items',
    ]);
    expect(createRequests()).toHaveLength(1);
    expect(listRequests().map(bodyOf)).toEqual(
      Array(2).fill({ items: [{ productId: 'milk', variantId: null }] })
    );
  });

  it('retains the created product over repeated add failures and guards the add-only retry', async () => {
    const button = await prepare('AI search');
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'created in the catalog, but could not be added to the list'
    );
    expect(createRequests().map(bodyOf)).toEqual([{ productName: 'milk' }]);
    fireEvent.click(screen.getByRole('button', { name: /Retry list add/ }));
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('created in the catalog');
    const pending = deferredResponse();
    addResponse = pending.response;
    const retry = screen.getByRole('button', { name: /Retry list add/ });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await waitFor(() => expect(listRequests()).toHaveLength(3));
    expect(createRequests()).toHaveLength(1);
    expect(listRequests().map(bodyOf)).toEqual(
      Array(3).fill({ items: [{ productId: 'milk', variantId: null }] })
    );
    expect(mocks.router.push).not.toHaveBeenCalled();
    await act(async () => pending.finish(json({ createdItems: [{ id: 'item-1' }] })));
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('resets the retry product and feedback when the query changes', async () => {
    const button = await prepare('AI search');
    fireEvent.click(button());
    await screen.findByRole('alert');
    fireEvent.change(screen.getByPlaceholderText('Search products...'), {
      target: { value: 'cream' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    createResponse = async () => json({ product: cream });
    await screen.findByRole('button', { name: /Create with AI/ });
    fireEvent.click(screen.getByRole('button', { name: /Create with AI/ }));
    await waitFor(() => expect(createRequests()).toHaveLength(2));
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(createRequests().map(bodyOf)).toEqual([
      { productName: 'milk' },
      { productName: 'cream' },
    ]);
    expect(bodyOf(listRequests()[1])).toEqual({ items: [{ productId: 'cream', variantId: null }] });
  });

  it('does not continue an obsolete AI create after the query changes while it is pending', async () => {
    const pending = deferredResponse();
    createResponse = pending.response;
    const button = await prepare('AI search');
    const create = button();
    act(() => {
      fireEvent.click(create);
      fireEvent.click(create);
    });
    await waitFor(() => expect(createRequests()).toHaveLength(1));
    fireEvent.change(screen.getByPlaceholderText('Search products...'), {
      target: { value: 'cream' },
    });
    await act(async () => pending.finish(json({ product })));
    expect(listRequests()).toHaveLength(0);
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe.each(paths)('%s post-success housekeeping', (path) => {
  it('guards same-turn taps on the initial add and processes success once', async () => {
    const pending = deferredResponse();
    addResponse = pending.response;
    const button = await prepare(path);
    const add = button();
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await waitFor(() => expect(listRequests()).toHaveLength(1));
    expect(bodyOf(listRequests()[0])).toEqual({
      items: [{ productId: 'milk', variantId: path === 'AI search' ? null : 'skimmed' }],
    });
    expect(createRequests()).toHaveLength(path === 'AI search' ? 1 : 0);
    expect(mocks.router.push).not.toHaveBeenCalled();
    await act(async () => pending.finish(json({ createdItems: [{ id: 'item-1' }] })));
    if (path !== 'favorites section') {
      await waitFor(() =>
        expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1')
      );
    } else {
      expect(await screen.findByRole('status')).toHaveTextContent('Item added to the list');
      expect(usageRequests().map(bodyOf)).toEqual([{ variantId: 'skimmed' }]);
    }
    expect(listRequests()).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['throw', 'reject'] as const)(
    'does not turn a committed add into a failed add when cache refreshes %s',
    async (failure) => {
      addResponse = async () => json({ createdItems: [{ id: 'item-1' }] });
      vi.spyOn(QueryClient.prototype, 'invalidateQueries').mockImplementation(() => {
        if (failure === 'throw') throw new Error('Cache unavailable');
        return Promise.reject(new Error('Cache unavailable'));
      });
      const button = await prepare(path);
      fireEvent.click(button());
      if (path !== 'favorites section') {
        await waitFor(() =>
          expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/lists/list-1')
        );
      } else {
        expect(await screen.findByRole('status')).toHaveTextContent('Item added to the list');
        expect(usageRequests()).toHaveLength(1);
      }
      expect(screen.queryByRole('alert')).toBeNull();
      expect(listRequests()).toHaveLength(1);
    }
  );
});

describe('catalog create feedback (not a list add)', () => {
  it.each(['callback throws', 'callback rejects', 'refresh throws'] as const)(
    'preserves catalog success when post-create housekeeping %s and guards reentrant submits',
    async (failure) => {
      const pending = deferredResponse();
      createResponse = pending.response;
      const onSuccess = vi.fn(() => {
        if (failure === 'callback throws') throw new Error('Cache failed');
        if (failure === 'callback rejects') return Promise.reject(new Error('Cache failed'));
      });
      if (failure === 'refresh throws')
        mocks.router.refresh.mockImplementation(() => {
          throw new Error('Refresh failed');
        });
      renderUI(
        <AddProductModal
          categoryId="dairy"
          categoryName="Dairy"
          isOpen
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      );
      fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'milk' } });
      const create = screen.getByRole('button', { name: /Create$/ });
      act(() => {
        fireEvent.click(create);
        fireEvent.click(create);
      });
      expect(createRequests().map(bodyOf)).toEqual([{ productName: 'milk', categoryId: 'dairy' }]);
      await act(async () => pending.finish(json({ product })));
      expect(await screen.findByRole('status')).toHaveTextContent('has been created');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(product);
      expect(createRequests()).toHaveLength(1);
      expect(screen.getByLabelText('Item name')).toHaveValue('');
    }
  );

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
