import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { messages } from '@/i18n/messages';
import { useListsManagement } from './useListsManagement';
import { useFavorites } from './useFavorites';

// A signed-in person opening /lists or /categories/favorites directly must not be bounced
// to /login while useSession() is still resolving; only a confirmed unauthenticated status
// may redirect (same contract as /history).

const router = vi.hoisted(() => ({ push: vi.fn() }));
const auth = vi.hoisted(() => ({
  data: undefined as { user: { id: string } } | null | undefined,
  status: 'loading' as 'loading' | 'authenticated' | 'unauthenticated',
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next-auth/react', () => ({
  useSession: () => auth,
}));

const listBody = [
  {
    id: 'list-1',
    name: 'Список',
    isActive: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    _count: { items: 0 },
  },
];

const favoriteBody = [
  {
    id: 'fav-1',
    productId: 'prod-1',
    product: {
      id: 'prod-1',
      name: 'Товар',
      nameEn: 'Product',
      emoji: '😀',
      isCustom: false,
      imageUrl: null,
      category: {
        id: 'cat-1',
        name: 'Категория',
        emoji: '🏷️',
        isCustom: false,
        imageUrl: null,
      },
    },
  },
];

let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  router.push.mockReset();
  auth.data = undefined;
  auth.status = 'loading';
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/lists') return Response.json(listBody);
    if (url === '/api/favorites') return Response.json(favoriteBody);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('useListsManagement session guard', () => {
  it('does not redirect to /login while the session is loading', () => {
    renderHook(() => useListsManagement(), { wrapper });

    expect(router.push).not.toHaveBeenCalled();
  });

  it('does not redirect or fetch while loading, then fetches lists and receives data once authenticated', async () => {
    const { result, rerender } = renderHook(() => useListsManagement(), { wrapper });
    expect(router.push).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    auth.data = { user: { id: 'user-b' } };
    auth.status = 'authenticated';
    rerender();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/lists'));
    await waitFor(() => expect(result.current.lists).toEqual(listBody));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('calls push exactly once for unauthenticated, even after repeated renders at the same status', async () => {
    auth.data = null;
    auth.status = 'unauthenticated';
    const { rerender } = renderHook(() => useListsManagement(), { wrapper });

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'));
    rerender();
    rerender();
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('calls push exactly once when loading transitions to unauthenticated', async () => {
    const { rerender } = renderHook(() => useListsManagement(), { wrapper });
    expect(router.push).not.toHaveBeenCalled();

    auth.data = null;
    auth.status = 'unauthenticated';
    rerender();

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'));
    rerender();
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});

describe('useFavorites session guard', () => {
  it('does not redirect to /login while the session is loading', () => {
    renderHook(() => useFavorites(), { wrapper });

    expect(router.push).not.toHaveBeenCalled();
  });

  it('does not redirect or fetch while loading, then fetches favorites and receives data once authenticated', async () => {
    const { result, rerender } = renderHook(() => useFavorites(), { wrapper });
    expect(router.push).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    auth.data = { user: { id: 'user-b' } };
    auth.status = 'authenticated';
    rerender();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/favorites'));
    await waitFor(() => expect(result.current.favorites).toEqual(favoriteBody));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('calls push exactly once for unauthenticated, even after repeated renders at the same status', async () => {
    auth.data = null;
    auth.status = 'unauthenticated';
    const { rerender } = renderHook(() => useFavorites(), { wrapper });

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'));
    rerender();
    rerender();
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('calls push exactly once when loading transitions to unauthenticated', async () => {
    const { rerender } = renderHook(() => useFavorites(), { wrapper });
    expect(router.push).not.toHaveBeenCalled();

    auth.data = null;
    auth.status = 'unauthenticated';
    rerender();

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'));
    rerender();
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});
