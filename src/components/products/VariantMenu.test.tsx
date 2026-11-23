import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import VariantMenu from './VariantMenu';
import type { Product } from '@/hooks/useProductSelection';
import { renderWithIntl } from '@/test/intl';

const product: Product = {
  id: 'milk',
  name: 'Молоко',
  nameEn: 'Milk',
  emoji: '🥛',
  isCustom: true,
  imageUrl: '/uploads/milk-ru.png',
  imageUrlEn: '/uploads/milk-en.png',
  variants: [
    { id: 'skimmed', name: 'Обезжиренное', nameEn: 'Skimmed', emoji: '' },
    { id: 'whole', name: 'Цельное', nameEn: 'Whole', emoji: '🐄' },
  ],
  category: {
    id: 'dairy',
    name: 'Молочное',
    nameEn: 'Dairy',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
  },
};

function MenuHarness({
  item = product,
  showFavorite = true,
  onDismiss = vi.fn(),
}: {
  item?: Product;
  showFavorite?: boolean;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(new Set());

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open variants
      </button>
      {open && (
        <VariantMenu
          product={item}
          pickedVariantId={null}
          favoriteVariantIds={favorites}
          showFavorite={showFavorite}
          onPick={() => {
            onDismiss();
            setOpen(false);
          }}
          onToggleFavorite={(id) => setFavorites(new Set([id]))}
          onClose={() => {
            onDismiss();
            setOpen(false);
          }}
        />
      )}
      <button type="button">Background action</button>
    </>
  );
}

function openMenu() {
  const opener = screen.getByRole('button', { name: 'Open variants' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole('dialog', { name: 'Milk: variants' }) };
}

function pressTab(target: HTMLElement, shiftKey = false) {
  return fireEvent.keyDown(target, { key: 'Tab', shiftKey });
}

const pictureSrc = (alt: string) =>
  decodeURIComponent(screen.getByRole('img', { name: alt }).getAttribute('src') ?? '');

describe('VariantMenu keyboard lifecycle', () => {
  it('moves focus from the opener into the dialog', () => {
    renderWithIntl(<MenuHarness />, { locale: 'en' });
    const { dialog } = openMenu();

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
  });

  it.each([true, false])('traps Tab and Shift+Tab with favorites %s', (showFavorite) => {
    renderWithIntl(<MenuHarness showFavorite={showFavorite} />, { locale: 'en' });
    const { dialog } = openMenu();
    const buttons = within(dialog).getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    expect(pressTab(last)).toBe(false);
    expect(document.activeElement).toBe(first);

    expect(pressTab(first, true)).toBe(false);
    expect(document.activeElement).toBe(last);

    buttons[1].focus();
    expect(pressTab(buttons[1])).toBe(true);
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('keeps keyboard navigation inside even if focus was moved to the background', () => {
    renderWithIntl(<MenuHarness />, { locale: 'en' });
    const { dialog } = openMenu();
    const background = screen.getByRole('button', { name: 'Background action' });
    const buttons = within(dialog).getAllByRole('button');

    background.focus();
    expect(pressTab(background)).toBe(false);
    expect(document.activeElement).toBe(buttons[0]);

    background.focus();
    expect(pressTab(background, true)).toBe(false);
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('traps both directions between header close and footer cancel without variants', () => {
    renderWithIntl(<MenuHarness item={{ ...product, variants: [] }} />, { locale: 'en' });
    openMenu();
    const close = screen.getByRole('button', { name: 'Close' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    close.focus();
    expect(pressTab(close)).toBe(true);
    cancel.focus();
    expect(pressTab(cancel)).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(pressTab(close, true)).toBe(false);
    expect(document.activeElement).toBe(cancel);
  });

  it('preserves focus across rerenders and restores the original opener on final close', () => {
    const firstDismiss = vi.fn();
    const latestDismiss = vi.fn();
    const { rerender } = renderWithIntl(<MenuHarness onDismiss={firstDismiss} />, {
      locale: 'en',
    });
    const { opener, dialog } = openMenu();
    const favorite = within(dialog).getAllByTitle('Add to favorites')[0];
    favorite.focus();
    const restoreFocus = vi.spyOn(opener, 'focus');

    fireEvent.click(favorite);
    expect(document.activeElement).toBe(favorite);
    expect(favorite.getAttribute('title')).toBe('Remove from favorites');

    rerender(<MenuHarness onDismiss={latestDismiss} />);
    expect(document.activeElement).toBe(favorite);
    expect(restoreFocus).not.toHaveBeenCalled();

    fireEvent.keyDown(favorite, { key: 'Escape' });
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(latestDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('uses the current tab boundaries after favorite buttons disappear on rerender', () => {
    const { rerender } = renderWithIntl(<MenuHarness />, { locale: 'en' });
    const { dialog } = openMenu();
    rerender(<MenuHarness showFavorite={false} />);
    const buttons = within(dialog).getAllByRole('button');
    const last = buttons[buttons.length - 1];

    last.focus();
    expect(pressTab(last)).toBe(false);
    expect(document.activeElement).toBe(buttons[0]);
    expect(pressTab(buttons[0], true)).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it.each(['Escape', 'close button', 'backdrop', 'variant'])(
    'restores focus to the opener after dismissal by %s',
    (dismissal) => {
      const onDismiss = vi.fn();
      renderWithIntl(<MenuHarness onDismiss={onDismiss} />, { locale: 'en' });
      const { opener, dialog } = openMenu();
      const variant = within(dialog).getByRole('button', { name: '🐄 Whole' });
      variant.focus();

      if (dismissal === 'Escape') fireEvent.keyDown(variant, { key: 'Escape' });
      if (dismissal === 'close button') {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      }
      if (dismissal === 'backdrop') fireEvent.click(dialog.parentElement!);
      if (dismissal === 'variant') fireEvent.click(variant);

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    }
  );
});

describe('VariantMenu localized images', () => {
  const englishOnly: Product = {
    ...product,
    variants: [
      {
        id: 'english-only',
        name: 'Обезжиренное',
        nameEn: 'Skimmed',
        emoji: '🍼',
        imageUrl: null,
        imageUrlEn: '/uploads/skimmed-en.png',
      },
    ],
  };

  it('shows an English-only variant image ahead of its emoji and the product image', () => {
    renderWithIntl(<MenuHarness item={englishOnly} />, { locale: 'en' });
    openMenu();

    expect(pictureSrc('Skimmed')).toContain('/uploads/skimmed-en.png');
    expect(screen.queryByText('🍼')).toBeNull();
  });

  it('does not show an English-only image in Russian', () => {
    renderWithIntl(<MenuHarness item={englishOnly} />);
    const opener = screen.getByRole('button', { name: 'Open variants' });
    fireEvent.click(opener);

    expect(screen.queryByRole('img', { name: 'Обезжиренное' })).toBeNull();
    expect(screen.getByText('🍼')).toBeTruthy();
  });

  it('falls back to the product image when the variant has no local image or emoji', () => {
    renderWithIntl(<MenuHarness />, { locale: 'en' });
    openMenu();

    expect(pictureSrc('Skimmed')).toContain('/uploads/milk-en.png');
    expect(screen.getByText('🐄')).toBeTruthy();
  });
});
