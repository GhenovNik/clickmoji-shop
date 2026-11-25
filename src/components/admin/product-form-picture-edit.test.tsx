import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test/intl';
import ProductForm, {
  type FormData as ProductFormData,
} from '@/components/admin/products/ProductForm';

// AGE-1667 Ya3 review: the form submits an EDIT of the picture languages, never "everything it can
// see". A product written by the previous release can hold its only English address in the legacy
// column; the form cannot see it, so an ordinary edit must not name English at all.

const categories = [
  { id: 'c1', name: 'Фрукты', nameEn: 'Fruits', emoji: '🍎', isCustom: false, imageUrl: null },
];

const RU = 'https://utfs.io/f/apple-ru.webp';
const EN = 'https://utfs.io/f/apple-en.webp';

// The dictionary holds no English entry; the English address (if any) lives in the legacy column,
// which the app does not read, so the form is given nothing about it.
const legacyOnlyEnglish = {
  id: 'p1',
  name: 'Яблоко',
  nameEn: 'Apple',
  emoji: '🍏',
  isCustom: true,
  imageUrl: 'https://utfs.io/f/apple.webp',
  localizedImages: null as Record<string, string> | null,
  categoryId: 'c1',
};

type Submit = (data: ProductFormData, imageUrl?: string) => Promise<void>;

function renderForm(product = legacyOnlyEnglish) {
  const onSubmit = vi.fn<Submit>(async () => undefined);
  renderWithIntl(
    <ProductForm product={product} categories={categories} onSubmit={onSubmit} onCancel={vi.fn()} />
  );
  return onSubmit;
}

async function save(onSubmit: ReturnType<typeof renderForm>) {
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  return onSubmit.mock.calls[0]![0];
}

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an ordinary edit of a product whose English picture only the legacy column holds', () => {
  it('renaming the product submits no picture language at all', async () => {
    const onSubmit = renderForm();

    const nameInput = screen.getByDisplayValue('Яблоко');
    fireEvent.change(nameInput, { target: { value: 'Яблоко красное' } });
    const data = await save(onSubmit);

    expect(data.name).toBe('Яблоко красное');
    // English is not mentioned, so the server leaves the dictionary and the mirror as stored.
    expect(data.localizedImages).toEqual({});
  });

  it('keeps an untouched language out of the edit when another one is not shown at all', async () => {
    const onSubmit = renderForm({ ...legacyOnlyEnglish, localizedImages: { ru: RU } });

    fireEvent.change(screen.getByDisplayValue('Яблоко'), { target: { value: 'Яблоко 2' } });
    const data = await save(onSubmit);

    expect(data.localizedImages).toEqual({});
  });
});

describe('an intentional picture edit', () => {
  it('picking a new English picture submits that language with its address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith('/api/emoji/library')
          ? new Response(
              JSON.stringify({
                items: [
                  {
                    id: 'x',
                    name: 'ТолькоEN',
                    nameEn: 'OnlyEN',
                    tags: [],
                    imageUrl: EN,
                    locale: 'en',
                    groupKey: 'g1',
                  },
                ],
              }),
              { status: 200 }
            )
          : new Response('{}', { status: 500 })
      )
    );
    const onSubmit = renderForm();

    fireEvent.click(screen.getByRole('button', { name: /библиотека/i }));
    fireEvent.click(await screen.findByRole('button', { name: /толькоen/i }));
    await screen.findByText('Новая (EN)');
    const data = await save(onSubmit);

    expect(data.localizedImages).toEqual({ en: EN });
  });

  it('removing a saved English picture submits an explicit removal of English only', async () => {
    const onSubmit = renderForm({ ...legacyOnlyEnglish, localizedImages: { ru: RU, en: EN } });

    fireEvent.click(screen.getByRole('button', { name: /убрать английскую версию/i }));
    const data = await save(onSubmit);

    expect(data.localizedImages).toEqual({ en: null });
  });

  it('unchecking the custom image removes the pictures it showed and nothing else', async () => {
    const withEnglish = renderForm({ ...legacyOnlyEnglish, localizedImages: { ru: RU, en: EN } });

    fireEvent.click(screen.getByRole('checkbox', { name: /кастомное изображение/i }));
    const data = await save(withEnglish);

    expect(data).toMatchObject({ isCustom: false, imageUrl: '' });
    expect(data.localizedImages).toEqual({ ru: null, en: null });
  });

  it('unchecking the custom image of a product with no visible language picture names none', async () => {
    const onSubmit = renderForm();

    fireEvent.click(screen.getByRole('checkbox', { name: /кастомное изображение/i }));
    const data = await save(onSubmit);

    expect(data.localizedImages).toEqual({});
  });
});
