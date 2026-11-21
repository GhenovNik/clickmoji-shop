import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// The modal's request goes to the real route handler: a payload field the route does not read
// must surface as a failed move, not only as a changed status code.

type UpdateManyArgs = { where: unknown; data: Record<string, unknown> };

const state = vi.hoisted(() => ({
  updated: [] as UpdateManyArgs[],
  status: 0,
  body: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => ({ session: { user: { id: 'admin-1', role: 'ADMIN' } } }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    category: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'drinks' ? { id: 'drinks', name: 'Напитки', nameEn: 'Drinks' } : null,
    },
    product: {
      updateMany: async (args: UpdateManyArgs) => {
        state.updated.push(args);
        return { count: 2 };
      },
    },
  },
}));

const route = await import('@/app/api/products/move-category/route');
const { default: ProductMoveModal } = await import('./ProductMoveModal');

const dairy = { id: 'dairy', name: 'Молочные продукты', emoji: '🥛' };
const drinks = { id: 'drinks', name: 'Напитки', emoji: '🥤' };
const products = [
  {
    id: 'milk',
    name: 'Молоко',
    nameEn: 'Milk',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
    categoryId: 'dairy',
  },
  {
    id: 'cheese',
    name: 'Сыр',
    nameEn: 'Cheese',
    emoji: '🧀',
    isCustom: false,
    imageUrl: null,
    categoryId: 'dairy',
  },
];

beforeEach(() => {
  state.updated = [];
  state.status = 0;
  state.body = null;
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      state.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const response = await route.POST(
        new Request(`http://localhost${url}`, {
          ...init,
          headers: { ...(init?.headers as Record<string, string>), cookie: 'NEXT_LOCALE=ru' },
        })
      );
      state.status = response.status;
      return response;
    })
  );
});

describe('ProductMoveModal -> POST /api/products/move-category', () => {
  it('moves the selected products into the selected category', async () => {
    const onMoveComplete = vi.fn();
    const onClose = vi.fn();

    render(
      <ProductMoveModal
        category={dairy}
        products={products}
        allCategories={[dairy, drinks]}
        onClose={onClose}
        onMoveComplete={onMoveComplete}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Молоко/ }));
    fireEvent.click(screen.getByRole('button', { name: /Сыр/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'drinks' } });
    fireEvent.click(screen.getByRole('button', { name: /Переместить/ }));

    await waitFor(() => expect(state.status).toBe(200));
    expect(onMoveComplete).toHaveBeenCalledTimes(1);
    expect(state.body).toEqual({ productIds: ['milk', 'cheese'], newCategoryId: 'drinks' });
    expect(state.updated).toEqual([
      { where: { id: { in: ['milk', 'cheese'] } }, data: { categoryId: 'drinks' } },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
