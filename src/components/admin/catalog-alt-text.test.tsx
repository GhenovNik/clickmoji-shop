import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test/intl';
import ProductsTable from './products/ProductsTable';
import CategoriesTable from './categories/CategoriesTable';

// Admin tables draw each custom image in two layouts (table and cards). Its alt text follows the
// same one-line name rule as the visible name, so a screen reader hears the interface language,
// and falls back to Russian when the English name is missing. The visible name stays in the DOM.

const category = {
  id: 'cat-1',
  name: 'Фрукты',
  nameEn: 'Fruit',
  emoji: '🍎',
  isCustom: true,
  imageUrl: '/cat.png',
  order: 1,
  _count: { products: 1 },
};

const product = (nameEn: string, categoryNameEn = 'Fruit') => ({
  id: 'p-1',
  name: 'Яблоко',
  nameEn,
  emoji: '🍏',
  isCustom: true,
  imageUrl: '/apple.png',
  imageUrlEn: null,
  categoryId: 'cat-1',
  category: {
    id: 'cat-1',
    name: 'Фрукты',
    nameEn: categoryNameEn,
    emoji: '🍎',
    isCustom: true,
    imageUrl: '/cat.png',
  },
});

const noop = vi.fn();

function altsOf(container: HTMLElement) {
  return within(container)
    .getAllByRole('img')
    .map((img) => img.getAttribute('alt'));
}

describe.each([
  { locale: 'en' as const, names: ['Apple', 'Fruit'], missing: ['Яблоко', 'Фрукты'] },
  { locale: 'ru' as const, names: ['Яблоко', 'Фрукты'], missing: ['Яблоко', 'Фрукты'] },
])('admin image alt in $locale', ({ locale, names, missing }) => {
  it('uses the one-line name of the interface language when the English name is filled', () => {
    const { container } = renderWithIntl(
      <ProductsTable products={[product('Apple')]} onEdit={noop} onDelete={noop} />,
      { locale }
    );
    const alts = altsOf(container);
    // Table row and mobile card each draw the product image and the category image.
    expect(alts).toHaveLength(4);
    expect(alts.filter((alt) => alt === names[0])).toHaveLength(names[0] === names[1] ? 4 : 2);
    expect(alts.filter((alt) => alt === names[1])).toHaveLength(names[0] === names[1] ? 4 : 2);
  });

  it('falls back to the Russian name when the English name is missing, no empty alt', () => {
    const { container } = renderWithIntl(
      <ProductsTable products={[product('', '')]} onEdit={noop} onDelete={noop} />,
      { locale }
    );
    const alts = altsOf(container);
    expect(alts).toHaveLength(4);
    expect(alts.filter((alt) => alt === missing[0])).toHaveLength(2);
    expect(alts.filter((alt) => alt === missing[1])).toHaveLength(2);
    expect(alts).not.toContain('');
  });

  it('keeps the category image name in both category layouts', () => {
    const withEn = { ...category };
    const withoutEn = { ...category, nameEn: '' };
    // Each card's visible name is the same one-line name as its alt text.
    const fill = renderWithIntl(
      <CategoriesTable
        categories={[withEn]}
        onEdit={noop}
        onDelete={noop}
        onManageProducts={noop}
      />,
      { locale }
    );
    const filledAlts = altsOf(fill.container);
    expect(filledAlts.length).toBeGreaterThanOrEqual(2);
    expect(filledAlts.every((alt) => alt === names[1])).toBe(true);
    fill.unmount();

    const empty = renderWithIntl(
      <CategoriesTable
        categories={[withoutEn]}
        onEdit={noop}
        onDelete={noop}
        onManageProducts={noop}
      />,
      { locale }
    );
    const emptyAlts = altsOf(empty.container);
    expect(emptyAlts.length).toBeGreaterThanOrEqual(2);
    expect(emptyAlts.every((alt) => alt === missing[1])).toBe(true);
    // The visible name is still in the same card, so the name is not lost.
    expect(screen.getAllByText(missing[1]).length).toBeGreaterThan(0);
  });
});
