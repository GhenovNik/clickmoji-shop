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
    if (url === '/api/favorites') return Response.json([]);
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

  it('does not redirect after loading resolves to authenticated, and fetches lists', async () => {
    const { rerender } = renderHook(() => useListsManagement(), { wrapper });
    expect(router.push).not.toHaveBeenCalled();

    auth.data = { user: { id: 'user-b' } };
    auth.status = 'authenticated';
    rerender();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/lists'));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('redirects to /login when the visitor is unauthenticated', async () => {
    auth.data = null;
    auth.status = 'unauthenticated';
    renderHook(() => useListsManagement(), { wrapper });

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'));
  });
});

describe('useFavorites session guard', () => {
  it('does not redirect to /login while the session is loading', () => {
    renderHook(() => useFavorites(), { wrapper });

    expect(router.push).not.toHaveBeenCalled();
  });

  it('does not redirect after loading resolves to authenticated, and fetches favorites', async () => {
    const { rerender } = renderHook(() => useFavorites(), { wrapper });
    expect(router.push).not.toHaveBeenCalled();

    auth.data = { user: { id: 'user-b' } };
    auth.status = 'authenticated';
    rerender();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/favorites'));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('redirects to /login when the visitor is unauthenticated', async () => {
    auth.data = null;
    auth.status = 'unauthenticated';
    renderHook(() => useFavorites(), { wrapper });

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'));
  });
});
