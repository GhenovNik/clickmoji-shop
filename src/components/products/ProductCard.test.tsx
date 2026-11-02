import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
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

function renderCard(
  item: Product,
  locale: 'ru' | 'en',
  isSelected = false,
  selectedVariantId: string | null = null
) {
  const handlers = {
    onToggle: vi.fn(),
    onSelectVariant: vi.fn(),
    onToggleFavorite: vi.fn(),
    onToggleVariantFavorite: vi.fn(),
  };
  renderWithIntl(
    <ProductCard
      product={item}
      isSelected={isSelected}
      isFavorite={false}
      showFavorite
      selectedVariantId={selectedVariantId}
      favoriteVariantIds={new Set()}
      {...handlers}
    />,
    { locale }
  );
  return handlers;
}

const pictureSrc = (alt: string) =>
  decodeURIComponent(screen.getByRole('img', { name: alt }).getAttribute('src') ?? '');

describe('a product card', () => {
  it('shows the English name, variant and picture in English', () => {
    renderCard(product, 'en', true);

    expect(screen.getByText('Milk')).toBeTruthy();
    expect(screen.queryByText('Молоко')).toBeNull();
    expect(screen.getByRole('button', { name: 'Variants · 1' })).toBeTruthy();
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
    expect(screen.getByRole('button', { name: 'Варианты · 1' })).toBeTruthy();
    expect(screen.getByTitle('Добавить в избранное')).toBeTruthy();
    expect(pictureSrc('Молоко')).toContain('milk-ru.png');
  });
});

describe('the variants of a product card', () => {
  it('stay hidden behind a small button until it is pressed', () => {
    renderCard(product, 'en');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Skimmed')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Variants · 1' }));

    const menu = screen.getByRole('dialog', { name: 'Milk: variants' });
    expect(menu.textContent).toContain('Skimmed');
  });

  it('pick the variant for the product and close the menu', () => {
    const handlers = renderCard(product, 'ru');

    fireEvent.click(screen.getByRole('button', { name: 'Варианты · 1' }));
    fireEvent.click(screen.getByTestId('variant-card'));

    expect(handlers.onSelectVariant).toHaveBeenCalledWith(product, 'v-1');
    expect(handlers.onToggle).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('show the picked variant on the card', () => {
    renderCard(product, 'en', true, 'v-1');

    expect(screen.getByRole('button', { name: 'Skimmed' })).toBeTruthy();
  });

  it('star a variant on its own, not the product', () => {
    const handlers = renderCard(product, 'en');

    fireEvent.click(screen.getByRole('button', { name: 'Variants · 1' }));
    const menu = screen.getByRole('dialog');
    fireEvent.click(menu.querySelector('[title="Add to favorites"]') as HTMLElement);

    expect(handlers.onToggleVariantFavorite).toHaveBeenCalledWith('v-1');
    expect(handlers.onToggleFavorite).not.toHaveBeenCalled();
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

  it('shows a starred variant as a card of its own and selects it by its own key', () => {
    const onToggle = vi.fn();
    const onRemove = vi.fn();
    const variantFavorite: FavoriteProduct = {
      ...favorite,
      id: 'vfav-1',
      variant: {
        id: 'v-1',
        name: 'Обезжиренное',
        nameEn: 'Skimmed',
        emoji: '🥛',
        imageUrl: null,
      },
    };
    renderWithIntl(
      <FavoriteCard
        favorite={variantFavorite}
        isSelected={false}
        onToggle={onToggle}
        onRemove={onRemove}
      />,
      { locale: 'en' }
    );

    expect(screen.getByText('Skimmed').getAttribute('lang')).toBe('en');
    expect(screen.queryByText('Milk')).toBeNull();
    fireEvent.click(screen.getByText('Skimmed'));
    expect(onToggle).toHaveBeenCalledWith('variant:v-1');
    fireEvent.click(screen.getByTitle('Remove from favorites'));
    expect(onRemove).toHaveBeenCalledWith(variantFavorite);
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
