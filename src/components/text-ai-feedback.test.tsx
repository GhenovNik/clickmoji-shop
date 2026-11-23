import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test/intl';
import AddProductModal from '@/components/products/AddProductModal';
import BulkImportModal from '@/components/admin/products/BulkImportModal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

for (const route of ['smart-create', 'bulk-import'] as const) {
  describe(`${route} text overload feedback`, () => {
    it.each([
      ['ru', 'Сервис распознавания сейчас перегружен, попробуйте через минуту'],
      ['en', 'The recognition service is overloaded right now. Please try again in a minute.'],
    ] as const)(
      'shows %s 503 inline without clearing input or opening an alert',
      async (locale, message) => {
        const fetch = vi.fn(
          async () => new Response(JSON.stringify({ error: message }), { status: 503 })
        );
        vi.stubGlobal('fetch', fetch);
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        const onClose = vi.fn();
        const onSuccess = vi.fn();
        renderWithIntl(
          route === 'smart-create' ? (
            <AddProductModal
              isOpen
              categoryId="dairy"
              categoryName="Dairy"
              onClose={onClose}
              onSuccess={onSuccess}
            />
          ) : (
            <BulkImportModal onClose={onClose} onImportComplete={onSuccess} />
          ),
          { locale }
        );
        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: 'Milk' } });
        await act(async () => {
          if (route === 'smart-create') fireEvent.submit(input.closest('form')!);
          else fireEvent.click(screen.getByRole('button', { name: /Импортировать|Import/ }));
        });
        expect(alert).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent(message);
        expect(input).toHaveValue('Milk');
        expect(input).toBeEnabled();
        expect(onClose).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    );
  });
}
