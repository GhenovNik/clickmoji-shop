import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, screen } from '@testing-library/react';
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

const longNote =
  'Купить два пакета молока без лактозы, проверить срок годности и выбрать упаковку без повреждений.\n' +
  'Пробелы в конце строки' +
  ' '.repeat(80) +
  '\n' +
  'Если нужного нет, взять другой бренд. ' +
  'ОченьДлинноеСловоБезПробелов'.repeat(8);

describe.each([false, true])('shopping item interactions (purchased: %s)', (isPurchased) => {
  function renderInteractiveItem(locale: 'ru' | 'en' = 'ru', note = longNote) {
    const handlers = { onToggle: vi.fn(), onRemove: vi.fn(), onUpdateNote: vi.fn() };
    const view = renderWithIntl(
      <ShoppingListItem item={{ ...item, isPurchased, note }} {...handlers} />,
      { locale }
    );
    return { ...view, ...handlers };
  }

  it('does not toggle from the title, variant, image or card background', () => {
    const { container, onToggle } = renderInteractiveItem();

    fireEvent.click(screen.getByText('Молоко'));
    fireEvent.click(screen.getByText('Обезжиренное'));
    fireEvent.click(screen.getByRole('img', { name: 'Молоко' }));
    fireEvent.click(container.firstElementChild!);

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('expands the entire note inline without changing purchase status', () => {
    const { onToggle, onRemove, onUpdateNote } = renderInteractiveItem();
    const noteButton = screen.getByRole('button', { name: /Развернуть комментарий/ });
    const note = screen.getByText(longNote, { normalizer: (text) => text });

    expect(noteButton).toHaveAttribute('aria-expanded', 'false');
    expect(note).toHaveClass('line-clamp-1');
    fireEvent.click(noteButton);

    expect(noteButton).toHaveAttribute('aria-expanded', 'true');
    expect(note).not.toHaveClass('line-clamp-1');
    expect(note).toHaveClass('whitespace-break-spaces', '[overflow-wrap:anywhere]');
    expect(note).toHaveTextContent('Если нужного нет, взять другой бренд.');
    expect(onToggle).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onUpdateNote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Свернуть комментарий/ }));
    expect(noteButton).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([
    ['ru', 'Куплено: Молоко'],
    ['en', 'Purchased: Milk'],
  ] as const)('toggles only with a named native button in %s', (locale, name) => {
    const { onToggle, onRemove, onUpdateNote } = renderInteractiveItem(locale);
    const toggle = screen.getByRole('button', { name, pressed: isPurchased });

    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveClass('min-w-11', 'min-h-11');
    fireEvent.click(toggle);

    expect(onToggle).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(onRemove).not.toHaveBeenCalled();
    expect(onUpdateNote).not.toHaveBeenCalled();
  });

  it('removes the item without toggling it', () => {
    const { onToggle, onRemove } = renderInteractiveItem();

    fireEvent.click(screen.getByRole('button', { name: 'Удалить товар: Молоко' }));

    expect(onRemove).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('preserves note editor availability and saves without toggling', () => {
    const { onToggle, onUpdateNote } = renderInteractiveItem('ru', 'Старый комментарий');
    const edit = screen.queryByRole('button', { name: 'Редактировать комментарий: Молоко' });
    if (isPurchased) {
      expect(edit).not.toBeInTheDocument();
      return;
    }

    expect(edit).toBeInTheDocument();
    fireEvent.click(edit!);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('Старый комментарий');
    fireEvent.change(input, { target: { value: 'Новый комментарий' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ок' }));

    expect(onUpdateNote).toHaveBeenCalledExactlyOnceWith(item.id, 'Новый комментарий');
    expect(onToggle).not.toHaveBeenCalled();
  });
});
