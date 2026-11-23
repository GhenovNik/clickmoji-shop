import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, screen } from '@testing-library/react';
import ShoppingListItem from './ShoppingListItem';
import type { Item } from '@/hooks/useShoppingListItems';
import { renderWithIntl } from '@/test/intl';

const item: Item = {
  id: 'milk',
  isPurchased: false,
  product: {
    id: 'milk',
    name: 'Молоко',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
    category: { name: 'Молочное', emoji: '🥛', order: 1 },
  },
};

describe.each(['list', 'grid'] as const)('item removal in %s view', (view) => {
  function setup(busy = false) {
    const onRemove = vi.fn();
    const onToggle = vi.fn();
    const result = renderWithIntl(
      <ShoppingListItem
        item={item}
        view={view}
        busy={busy}
        onRemove={onRemove}
        onToggle={onToggle}
      />
    );
    return { ...result, onRemove, onToggle };
  }

  function swipe(element: Element, endX: number, endY: number) {
    fireEvent.touchStart(element, { touches: [{ clientX: 120, clientY: 100 }] });
    fireEvent.touchEnd(element, { changedTouches: [{ clientX: endX, clientY: endY }] });
  }

  it('requires confirmation after horizontal swipe and permits cancellation', () => {
    const { onRemove, onToggle } = setup();
    const row = screen.getByTestId('shopping-item');
    swipe(row, 40, 102);
    expect(screen.getByText('Удалить товар?')).toBeVisible();
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByText('Удалить товар?')).not.toBeInTheDocument();
    swipe(row, 40, 102);
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does not treat vertical scrolling or touching an action as a swipe', () => {
    const { onRemove } = setup();
    swipe(screen.getByTestId('shopping-item'), 105, 25);
    swipe(screen.getByRole('button', { name: 'Куплено: Молоко' }), 40, 102);
    expect(screen.queryByText('Удалить товар?')).not.toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('provides a keyboard-accessible confirmation and suppresses removal while busy', () => {
    const { onRemove, rerender } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Удалить товар: Молоко' }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText('Удалить товар?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    rerender(
      <ShoppingListItem item={item} view={view} busy onRemove={onRemove} onToggle={vi.fn()} />
    );
    swipe(screen.getByTestId('shopping-item'), 40, 102);
    expect(screen.queryByText('Удалить товар?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить товар: Молоко' })).toBeDisabled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
