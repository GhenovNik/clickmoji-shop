import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

// AGE-1667 Ya3: a picture language is added in one place, `src/lib/image-languages.ts`. This file
// adds an invented language `xx` to that list (and nowhere else) and checks that everything that
// follows the list follows it: the selector, the saved dictionary, the library grouping and the
// admin form. Nothing here is told about `xx` besides the list.
vi.mock('@/lib/image-languages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/image-languages')>()),
  IMAGE_LANGUAGES: ['ru', 'en', 'xx'],
}));

import ProductForm, { type FormData as ProductFormData } from './products/ProductForm';
import { groupLibraryItems } from '@/lib/emoji-library-picture';
import { mergeLocalizedImages } from '@/lib/picture-storage';
import { productImageUrl } from '@/lib/product-image';
import { renderWithIntl } from '@/test/intl';

const MAIN = 'https://utfs.io/f/main.webp';
const EN = 'https://utfs.io/f/en.webp';
const XX = 'https://utfs.io/f/xx.webp';
const RU = 'https://utfs.io/f/ru.webp';
const FR = 'https://utfs.io/f/fr.webp';

const categories = [
  { id: 'c1', name: 'Фрукты', nameEn: 'Fruits', emoji: '🍎', isCustom: false, imageUrl: null },
];

function renderForm(localizedImages: Record<string, string>, locale: 'ru' | 'en' = 'ru') {
  const onSubmit = vi.fn(async (_data: ProductFormData, _imageUrl?: string) => undefined);
  renderWithIntl(
    <ProductForm
      product={{
        id: 'p1',
        name: 'Яблоко',
        nameEn: 'Apple',
        emoji: '🍏',
        isCustom: true,
        imageUrl: MAIN,
        imageTextLocale: 'none',
        localizedImages,
        categoryId: 'c1',
      }}
      categories={categories}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
    { locale }
  );
  return onSubmit;
}

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
});

describe('a picture language added only to the list (xx)', () => {
  it('is selected, stored and grouped without any other change', () => {
    expect(productImageUrl({ imageUrl: MAIN, localizedImages: { xx: XX } }, 'xx')).toBe(XX);

    // The edit of the new language is accepted; an entry of an unlisted language is kept untouched.
    expect(mergeLocalizedImages({ fr: FR, en: EN }, { xx: XX })).toEqual({ fr: FR, xx: XX });

    const [group] = groupLibraryItems([
      {
        id: '1',
        name: 'Яблоко',
        nameEn: 'Apple',
        tags: [],
        imageUrl: RU,
        locale: 'ru',
        groupKey: 'g',
      },
      {
        id: '2',
        name: 'Яблоко',
        nameEn: 'Apple',
        tags: [],
        imageUrl: XX,
        locale: 'xx',
        groupKey: 'g',
      },
      {
        id: '3',
        name: 'Яблоко',
        nameEn: 'Apple',
        tags: [],
        imageUrl: FR,
        locale: 'fr',
        groupKey: 'g',
      },
    ]);
    expect(group).toMatchObject({ imageUrl: RU, localizedImages: { xx: XX } });
    expect(group!.localizedImages).not.toHaveProperty('fr');
  });

  it('gets a picture field in the form, with the code as its label', () => {
    renderForm({ en: EN, xx: XX });

    expect(screen.getByText(/Версия: XX/)).toBeTruthy();
    // English keeps its own wording.
    expect(screen.getByText('Английская версия (с надписями):')).toBeTruthy();
  });

  it('keeps the English wording in the English interface and labels the new language generically', () => {
    renderForm({ en: EN, xx: XX }, 'en');

    expect(screen.getByText('English version (with labels):')).toBeTruthy();
    expect(screen.getByText(/XX version \(with labels\):/)).toBeTruthy();
  });

  it('removes only its own picture and saves the others', async () => {
    const onSubmit = renderForm({ en: EN, xx: XX });

    fireEvent.click(screen.getByRole('button', { name: /убрать версию: XX/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ localizedImages: { en: EN } });
  });

  it('shows a field for the main language too: its picture is a dictionary entry when the main one carries other text', async () => {
    const onSubmit = renderForm({ ru: RU, en: EN });

    expect(screen.getByText(/Версия: русский/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /убрать версию: русский/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ localizedImages: { en: EN } });
    expect(onSubmit.mock.calls[0]![0].localizedImages).not.toHaveProperty('ru');
  });
});
