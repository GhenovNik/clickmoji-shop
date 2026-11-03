import { act, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test/intl';
import ImportListModal from './ImportListModal';

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('partial import retry', () => {
  it('keeps the partial report open and submits only reviewed failed entries on retry', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        requests.push(JSON.parse(options!.body as string));
        return new Response(
          JSON.stringify({
            results:
              requests.length === 1
                ? {
                    added: [{ name: 'Milk', category: 'Dairy' }],
                    created: [],
                    skipped: [],
                    failed: [{ product: { nameRu: 'Хлеб', nameEn: 'Bread' }, reason: 'Try again' }],
                  }
                : {
                    added: [{ name: 'Bread', category: 'Bakery' }],
                    created: [],
                    skipped: [],
                    failed: [],
                  },
          })
        );
      })
    );
    const onClose = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    renderWithIntl(
      <QueryClientProvider client={client}>
        <ImportListModal listId="list-1" isOpen onClose={onClose} />
      </QueryClientProvider>,
      { locale: 'en' }
    );
    fireEvent.change(screen.getByLabelText('Paste your shopping list'), {
      target: { value: 'Milk, Bread' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Paste your shopping list').closest('form')!);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByRole('status').textContent).toContain('partially');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review and retry failed entries' }));
    expect((screen.getByLabelText('Paste your shopping list') as HTMLTextAreaElement).value).toBe(
      'Bread'
    );
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Paste your shopping list').closest('form')!);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(requests).toEqual([
      { listId: 'list-1', text: 'Milk, Bread' },
      { listId: 'list-1', text: 'Bread' },
    ]);
    expect(screen.getByRole('status').textContent).toContain('Import complete');
  });
});
