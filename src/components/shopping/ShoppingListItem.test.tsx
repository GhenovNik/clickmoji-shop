import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import ShoppingListItem from '@/components/shopping/ShoppingListItem';
import type { Item } from '@/hooks/useShoppingListItems';
import { renderWithIntl } from '@/test/intl';

// A list item shows the catalogue product in the active language: its name, its variant and,
// for pictures with packaging text, the picture made for that language.

const item: Item = {
  id: 'item-1',
  isPurchased: false,
  note: null,
  product: {
    id: 'milk',
    name: 'Молоко',
    nameEn: 'Milk',
    emoji: '🥛',
    isCustom: true,
    imageUrl: '/uploads/milk-ru.png',
    imageUrlEn: '/uploads/milk-en.png',
    category: { name: 'Молочное', nameEn: 'Dairy', emoji: '🥛', order: 1 },
  },
  variant: { id: 'v-1', name: 'Обезжиренное', nameEn: 'Skimmed', emoji: '🥛' },
};

function renderItem(locale: 'ru' | 'en') {
  return renderWithIntl(
    <ShoppingListItem item={item} onToggle={vi.fn()} onRemove={vi.fn()} onUpdateNote={vi.fn()} />,
    { locale }
  );
}

describe('a shopping list item', () => {
  it('shows the English name, variant and picture in English', () => {
    renderItem('en');

    expect(screen.getByText('Milk')).toBeTruthy();
    expect(screen.getByText('Skimmed')).toBeTruthy();
    expect(screen.queryByText('Молоко')).toBeNull();
    const picture = screen.getByRole('img', { name: 'Milk' });
    expect(decodeURIComponent(picture.getAttribute('src') ?? '')).toContain('milk-en.png');
  });

  it('keeps the Russian name and picture in Russian', () => {
    renderItem('ru');

    expect(screen.getByText('Молоко')).toBeTruthy();
    expect(screen.getByText('Обезжиренное')).toBeTruthy();
    const picture = screen.getByRole('img', { name: 'Молоко' });
    expect(decodeURIComponent(picture.getAttribute('src') ?? '')).toContain('milk-ru.png');
  });
});
