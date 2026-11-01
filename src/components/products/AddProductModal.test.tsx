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
