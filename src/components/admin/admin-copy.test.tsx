import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '@/test/intl';
import UsersTable from '@/components/admin/users/UsersTable';
import ProductMoveModal from '@/components/admin/categories/ProductMoveModal';
import EmojiPicker from '@/components/admin/shared/EmojiPicker';
import type { User } from '@/hooks/admin/useUsers';

// The admin area reads its copy from the "admin" namespace: Russian stays as it was, English
// replaces every label, and dates and plurals follow the active language.

const admin: User = {
  id: 'u1',
  email: 'admin@example.com',
  name: 'Anna',
  image: null,
  role: 'ADMIN',
  createdAt: '2026-03-05T12:00:00.000Z',
  updatedAt: '2026-03-05T12:00:00.000Z',
  completedSessions: 4,
  _count: { lists: 2, favorites: 7 },
};

const fruit = { id: 'c1', name: 'Фрукты', nameEn: 'Fruit', emoji: '🍎' };
const dairy = { id: 'c2', name: 'Молочное', nameEn: 'Dairy', emoji: '🥛' };
const apple = {
  id: 'p1',
  name: 'Яблоко',
  nameEn: 'Apple',
  emoji: '🍏',
  isCustom: false,
  imageUrl: null,
  categoryId: 'c1',
};
const pear = { ...apple, id: 'p2', name: 'Груша', nameEn: 'Pear', emoji: '🍐' };

function renderMoveModal(locale: 'ru' | 'en') {
  renderWithIntl(
    <ProductMoveModal
      category={fruit}
      products={[apple, pear]}
      allCategories={[fruit, dairy]}
      onClose={vi.fn()}
      onMoveComplete={vi.fn()}
    />,
    { locale }
  );
}

describe('UsersTable', () => {
  it('keeps the Russian copy by default', () => {
    renderWithIntl(<UsersTable users={[admin]} onEdit={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByText('Дата регистрации')).toBeTruthy();
    expect(screen.getByText('Администратор')).toBeTruthy();
    expect(screen.getByText('Списков: 2')).toBeTruthy();
    expect(screen.getByText('05.03.2026')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Удалить' })).toHaveLength(2);
  });

  it('renders English labels and an English date', () => {
    renderWithIntl(<UsersTable users={[admin]} onEdit={vi.fn()} onDelete={vi.fn()} />, {
      locale: 'en',
    });

    expect(screen.getByText('Signed up')).toBeTruthy();
    expect(screen.getByText('Administrator')).toBeTruthy();
    expect(screen.getByText('Lists: 2')).toBeTruthy();
    expect(screen.getByText('Favorites: 7')).toBeTruthy();
    expect(screen.getByText('3/5/2026')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe('ProductMoveModal', () => {
  it('pluralizes the move target in Russian', () => {
    renderMoveModal('ru');

    fireEvent.click(screen.getByText('Яблоко'));
    fireEvent.click(screen.getByText('Груша'));

    expect(screen.getByText('Переместить 2 товара в:')).toBeTruthy();
  });

  it('shows English copy and English catalogue names', () => {
    renderMoveModal('en');

    expect(screen.getByText('🍎 Manage products: Fruit')).toBeTruthy();
    expect(screen.getByText('Total products: 2')).toBeTruthy();

    fireEvent.click(screen.getByText('Apple'));
    expect(screen.getByText('Move 1 product to:')).toBeTruthy();
    expect(screen.getByRole('option', { name: '🥛 Dairy' })).toBeTruthy();

    fireEvent.click(screen.getByText('Pear'));
    expect(screen.getByText('Move 2 products to:')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe('ProductMoveModal pictures', () => {
  const labelled = {
    ...apple,
    isCustom: true,
    imageUrl: 'https://utfs.io/f/apple-ru.webp',
    imageUrlEn: 'https://utfs.io/f/apple-en.webp',
  };

  function pictureSrc(locale: 'ru' | 'en') {
    renderWithIntl(
      <ProductMoveModal
        category={fruit}
        products={[labelled]}
        allCategories={[fruit, dairy]}
        onClose={vi.fn()}
        onMoveComplete={vi.fn()}
      />,
      { locale }
    );
    return decodeURIComponent(document.querySelector('img')?.getAttribute('src') ?? '');
  }

  it('shows the English picture of a labelled product in English', () => {
    expect(pictureSrc('en')).toContain('apple-en.webp');
  });

  it('keeps the main picture in Russian', () => {
    expect(pictureSrc('ru')).toContain('apple-ru.webp');
  });
});

describe('EmojiPicker', () => {
  it('labels the library tab in English', () => {
    renderWithIntl(
      <EmojiPicker
        value=""
        onChange={vi.fn()}
        productName=""
        onGenerateImage={vi.fn()}
        onSelectLibraryImage={vi.fn()}
      />,
      { locale: 'en' }
    );

    expect(screen.getByRole('button', { name: '📚 Library' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '🔍 Suggest' })).toBeTruthy();
    expect(screen.getByPlaceholderText('🍎 (optional)')).toBeTruthy();
  });

  it('shows the translated generation error from the server', async () => {
    const message =
      'Генерация картинок сейчас недоступна (квота или ключ провайдера). Выберите обычный emoji.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: message }), { status: 503 }))
    );
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    renderWithIntl(
      <EmojiPicker value="" onChange={vi.fn()} productName="Молоко" onGenerateImage={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: /AI/ }));

    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(message));
    vi.unstubAllGlobals();
  });
});
