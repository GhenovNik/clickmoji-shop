import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import ProductCard from '@/components/products/ProductCard';
import FavoriteCard from '@/components/favorites/FavoriteCard';
import ProductSelectionBar from '@/components/products/ProductSelectionBar';
import type { Product } from '@/hooks/useProductSelection';
import type { FavoriteProduct } from '@/hooks/useFavorites';
import { renderWithIntl } from '@/test/intl';

// Catalogue cards show the product in the active language: its name, its variants and, for
// pictures with packaging text, the picture made for that language.

const product: Product = {
  id: 'milk',
  name: 'Молоко',
  nameEn: 'Milk',
  emoji: '🥛',
  isCustom: true,
  imageUrl: '/uploads/milk-ru.png',
  imageUrlEn: '/uploads/milk-en.png',
  variants: [{ id: 'v-1', name: 'Обезжиренное', nameEn: 'Skimmed', emoji: '' }],
  category: {
    id: 'dairy',
    name: 'Молочное',
    nameEn: 'Dairy',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
  },
};

function renderCard(item: Product, locale: 'ru' | 'en', isSelected = false) {
  return renderWithIntl(
    <ProductCard
      product={item}
      isSelected={isSelected}
      isFavorite={false}
      showFavorite
      selectedVariantId="v-1"
      onToggle={vi.fn()}
      onVariantChange={vi.fn()}
      onToggleFavorite={vi.fn()}
    />,
    { locale }
  );
}

const pictureSrc = (alt: string) =>
  decodeURIComponent(screen.getByRole('img', { name: alt }).getAttribute('src') ?? '');

describe('a product card', () => {
  it('shows the English name, variant and picture in English', () => {
    renderCard(product, 'en', true);

    expect(screen.getByText('Milk')).toBeTruthy();
    expect(screen.queryByText('Молоко')).toBeNull();
    expect(screen.getByRole('option', { name: 'Skimmed' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'No variant' })).toBeTruthy();
    expect(screen.getByTitle('Add to favorites')).toBeTruthy();
    expect(pictureSrc('Milk')).toContain('milk-en.png');
  });

  it('keeps the main picture in English when there is no English one', () => {
    renderCard({ ...product, imageUrlEn: null }, 'en');

    expect(pictureSrc('Milk')).toContain('milk-ru.png');
  });

  it('falls back to the Russian name in English when the translation is missing', () => {
    renderCard({ ...product, nameEn: '' }, 'en');

    const name = screen.getByText('Молоко');
    expect(name.getAttribute('lang')).toBe('ru');
  });

  it('shows the Russian name and the main picture in Russian', () => {
    renderCard(product, 'ru', true);

    expect(screen.getByText('Молоко').getAttribute('lang')).toBe('ru');
    expect(screen.getByRole('option', { name: 'Обезжиренное' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Без варианта' })).toBeTruthy();
    expect(screen.getByTitle('Добавить в избранное')).toBeTruthy();
    expect(pictureSrc('Молоко')).toContain('milk-ru.png');
  });
});

describe('a favorite card', () => {
  const favorite: FavoriteProduct = { id: 'fav-1', productId: product.id, product };

  it('shows the English name and picture in English', () => {
    renderWithIntl(
      <FavoriteCard favorite={favorite} isSelected={false} onToggle={vi.fn()} onRemove={vi.fn()} />,
      { locale: 'en' }
    );

    expect(screen.getByText('Milk').getAttribute('lang')).toBe('en');
    expect(screen.getByTitle('Remove from favorites')).toBeTruthy();
    expect(pictureSrc('Milk')).toContain('milk-en.png');
  });
});

describe('the selection bar', () => {
  it('speaks the active language', () => {
    renderWithIntl(
      <ProductSelectionBar count={2} adding={false} onAddToList={vi.fn()} isAuthenticated />,
      { locale: 'en' }
    );

    expect(screen.getByText('Selected: 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });
});
