import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '@/test/intl';

// The import modal renders exactly what POST /api/lists/import-text returns: fetch is wired to the
// real route handler, which parses a real (faked) provider reply. A reply mixing a valid product
// with a malformed entry must produce a report the modal can render.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  reply: '',
  items: [] as Row[],
  overloaded: false,
  locale: 'ru',
  transientRemaining: 0,
  attempts: 0,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => {
        state.attempts += 1;
        if (state.transientRemaining > 0) {
          state.transientRemaining -= 1;
          throw Object.assign(new Error('synthetic transient'), { status: 503 });
        }
        if (state.overloaded) throw Object.assign(new Error('synthetic overload'), { status: 503 });
        return { text: state.reply };
      },
    };
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
vi.mock('@/lib/ai-quota', () => ({ enforceAiQuota: vi.fn(async () => null) }));

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
      $executeRaw: vi.fn(async () => 1),
      list: { findUnique: async () => ({ id: 'list-1', userId: 'user-b' }) },
      category: {
        findMany: async () => [
          { id: 'cat-dairy', name: 'Молочные продукты', nameEn: 'Dairy', order: 1 },
        ],
      },
      product: {
        // The catalog fetch asks for the products visible to the user; only milk exists here.
        findMany: async () => [milk],
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
const { enforceAiQuota } = await import('@/lib/ai-quota');
const { prisma } = await import('@/lib/prisma');
const { default: ImportListModal } = await import('@/components/shopping/ImportListModal');

beforeEach(() => {
  vi.clearAllMocks();
  state.transientRemaining = 0;
  state.attempts = 0;
  process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-genai-key-for-tests';
  state.items = [];
  state.overloaded = false;
  state.locale = 'ru';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    // The browser sends the language cookie with every request, so the route answers in the
    // language the modal is rendered in.
    vi.fn((url: string, init?: RequestInit) =>
      route.POST(
        new Request(`http://localhost${url}`, {
          ...(init as RequestInit),
          headers: {
            ...(init?.headers as Record<string, string>),
            cookie: `NEXT_LOCALE=${state.locale}`,
          },
        })
      )
    )
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('import report from the real route', () => {
  it('a real service parsing failure compensates the text reservation', async () => {
    state.reply = 'synthetic invalid JSON';
    const response = await route.POST(
      new Request('http://localhost/api/lists/import-text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Молоко', listId: 'list-1' }),
      })
    );
    expect(response.status).toBe(500);
    expect(enforceAiQuota).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(state.attempts).toBe(1);
    expect(state.items).toHaveLength(0);
  });

  it('real service retries remain inside a single text quota reservation', async () => {
    vi.useFakeTimers();
    state.transientRemaining = 2;
    state.reply = JSON.stringify([
      { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' },
    ]);
    const pendingResponse = route.POST(
      new Request('http://localhost/api/lists/import-text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Молоко', listId: 'list-1' }),
      })
    );
    await vi.runAllTimersAsync();
    const response = await pendingResponse;
    expect(response.status).toBe(200);
    expect(state.attempts).toBe(3);
    expect(enforceAiQuota).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(state.items).toHaveLength(1);
  });

  it.each([
    ['ru', 'Сервис распознавания сейчас перегружен, попробуйте через минуту'],
    ['en', 'The recognition service is overloaded right now. Please try again in a minute.'],
  ] as const)(
    'shows %s overload inline, preserves text and allows retry',
    async (locale, message) => {
      vi.useFakeTimers();
      state.locale = locale;
      state.overloaded = true;
      const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
      state.reply = JSON.stringify([
        { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' },
        { nameRu: { text: 'Сыр' }, nameEn: ['Cheese'], categoryName: 'Dairy', emoji: 7 },
      ]);
      renderWithIntl(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
        >
          <ImportListModal listId="list-1" isOpen onClose={vi.fn()} />
        </QueryClientProvider>,
        { locale }
      );
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'Молоко\nсыр' } });
      const buttonName = locale === 'ru' ? /Импортировать/ : /Import$/;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: buttonName }));
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.getByRole('alert').textContent).toBe(message);
      expect((input as HTMLTextAreaElement).value).toBe('Молоко\nсыр');
      expect(alert).not.toHaveBeenCalled();
      expect(state.items).toEqual([]);
      state.overloaded = false;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: buttonName }));
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(
        screen.getByText(
          locale === 'ru' ? 'Импорт выполнен частично' : 'Import partially completed'
        )
      ).toBeTruthy();
      expect(state.items.map((item) => item.productId)).toEqual(['milk']);
      expect(alert).not.toHaveBeenCalled();
    }
  );

  it('renders a mixed valid + malformed AI reply: the item is added and the failure listed', async () => {
    state.reply = JSON.stringify([
      { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' },
      { nameRu: { text: 'Сыр' }, nameEn: ['Cheese'], categoryName: 'Dairy', emoji: 7 },
    ]);
    renderWithIntl(
      <QueryClientProvider client={new QueryClient()}>
        <ImportListModal listId="list-1" isOpen onClose={vi.fn()} />
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByLabelText('Вставьте список покупок'), {
      target: { value: 'Молоко\nсыр' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Импортировать/ }));

    expect(await screen.findByText('Импорт выполнен частично')).toBeTruthy();
    expect(state.items.map((item) => item.productId)).toEqual(['milk']);
    expect(
      screen.getByText(/Нераспознанная позиция: ИИ вернул нераспознанную строку/)
    ).toBeTruthy();
  });
});
