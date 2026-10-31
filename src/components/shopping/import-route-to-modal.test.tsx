import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The import modal renders exactly what POST /api/lists/import-text returns: fetch is wired to the
// real route handler, which parses a real (faked) provider reply. A reply mixing a valid product
// with a malformed entry must produce a report the modal can render.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ reply: '', items: [] as Row[] }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: async () => ({ text: state.reply }) };
  },
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: async () => ({ session: { user: { id: 'user-b', role: 'USER' } } }),
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0 }) };
});

// The daily AI budget is covered by src/app/api/ai-daily-quota.test.ts.
vi.mock('@/lib/ai-quota', () => ({ enforceAiQuota: async () => null }));

vi.mock('@/lib/prisma', () => {
  const milk = {
    id: 'milk',
    name: 'Молоко',
    nameEn: 'Milk',
    categoryId: 'cat-dairy',
    isGlobal: true,
    createdById: null,
  };
  return {
    prisma: {
      list: { findUnique: async () => ({ id: 'list-1', userId: 'user-b' }) },
      category: {
        findMany: async () => [
          { id: 'cat-dairy', name: 'Молочные продукты', nameEn: 'Dairy', order: 1 },
        ],
      },
      product: {
        // Only the milk product exists; the route asks with case-insensitive name/nameEn filters.
        findMany: async ({ where }: { where: { AND: Row[] } }) => {
          const names = JSON.stringify(where.AND[1]).toLowerCase();
          return names.includes('молоко') || names.includes('"milk"') ? [milk] : [];
        },
        create: async () => {
          throw new Error('no product should be created in this test');
        },
      },
      item: {
        create: async ({ data }: { data: Row }) => {
          state.items.push(data);
          return data;
        },
      },
    },
  };
});

const route = await import('@/app/api/lists/import-text/route');
const { default: ImportListModal } = await import('@/components/shopping/ImportListModal');

beforeEach(() => {
  process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-genai-key-for-tests';
  state.items = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      route.POST(new Request(`http://localhost${url}`, init as RequestInit))
    )
  );
});

describe('import report from the real route', () => {
  it('renders a mixed valid + malformed AI reply: the item is added and the failure listed', async () => {
    state.reply = JSON.stringify([
      { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' },
      { nameRu: { text: 'Сыр' }, nameEn: ['Cheese'], categoryName: 'Dairy', emoji: 7 },
    ]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ImportListModal listId="list-1" isOpen onClose={vi.fn()} />
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByLabelText('Вставьте список покупок'), {
      target: { value: 'Молоко\nсыр' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Импортировать/ }));

    expect(await screen.findByText('Импорт завершён!')).toBeTruthy();
    expect(state.items.map((item) => item.productId)).toEqual(['milk']);
    expect(
      screen.getByText(/Нераспознанная позиция: Unrecognized entry in the AI response/)
    ).toBeTruthy();
  });
});
