import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AddProductModal from './AddProductModal';
import { renderWithIntl } from '@/test/intl';

// The modal shows the server's error as it comes: smart-create answers in the request's
// language, so a Russian interface shows a Russian message.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function submit(message: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: message }), { status: 500 }))
  );
  renderWithIntl(
    <AddProductModal categoryId="c1" categoryName="Молочное" isOpen onClose={vi.fn()} />
  );
  fireEvent.change(screen.getByPlaceholderText(/Например/), { target: { value: 'Молоко' } });
  fireEvent.submit(screen.getByPlaceholderText(/Например/).closest('form')!);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AddProductModal errors', () => {
  it('shows the translated server error in the Russian interface', async () => {
    submit('ИИ не настроен. Обратитесь к администратору.');

    expect(await screen.findByText('ИИ не настроен. Обратитесь к администратору.')).toBeTruthy();
  });
});

describe('AddProductModal success', () => {
  it('does not show the model reasoning, which is English whatever the interface language', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              product: { name: 'Молоко', nameEn: 'Milk', emoji: '🥛' },
              aiSuggestion: { reasoning: 'Milk has a perfect Unicode emoji' },
              customEmojiGenerated: false,
            }),
            { status: 200 }
          )
      )
    );
    renderWithIntl(
      <AddProductModal categoryId="c1" categoryName="Молочное" isOpen onClose={vi.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText(/Например/), { target: { value: 'Молоко' } });
    fireEvent.submit(screen.getByPlaceholderText(/Например/).closest('form')!);

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Молоко');
    expect(status.textContent).not.toContain('Unicode');
    expect(alert).not.toHaveBeenCalled();
  });
});
