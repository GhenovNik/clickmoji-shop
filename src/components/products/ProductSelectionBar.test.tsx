import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import ProductSelectionBar from '@/components/products/ProductSelectionBar';
import { renderWithIntl } from '@/test/intl';

// AGE-1618 FR-1/AC-1: the guest sign-in link returns to the page the guest is on.

const nav = vi.hoisted(() => ({
  pathname: '/categories/c1/products',
  search: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.search,
}));

beforeEach(() => {
  nav.pathname = '/categories/c1/products';
  nav.search = new URLSearchParams();
});

describe('the sign-in link of the selection bar', () => {
  it('points at /login with the encoded current path (AC-1)', () => {
    renderWithIntl(
      <ProductSelectionBar count={2} adding={false} onAddToList={vi.fn()} isAuthenticated={false} />
    );

    const link = screen.getByRole('link', { name: 'Войти и добавить' });
    expect(link.getAttribute('href')).toBe('/login?callbackUrl=%2Fcategories%2Fc1%2Fproducts');
  });

  it('keeps the query string of the current page in the callbackUrl (FR-1)', () => {
    nav.search = new URLSearchParams('listId=l1');
    renderWithIntl(
      <ProductSelectionBar count={2} adding={false} onAddToList={vi.fn()} isAuthenticated={false} />
    );

    const link = screen.getByRole('link', { name: 'Войти и добавить' });
    expect(link.getAttribute('href')).toBe(
      `/login?callbackUrl=${encodeURIComponent('/categories/c1/products?listId=l1')}`
    );
  });

  it('saves the guest selection when the link is clicked (AC-4)', () => {
    const onBeforeLogin = vi.fn();
    renderWithIntl(
      <ProductSelectionBar
        count={2}
        adding={false}
        onAddToList={vi.fn()}
        isAuthenticated={false}
        onBeforeLogin={onBeforeLogin}
      />
    );

    fireEvent.click(screen.getByRole('link', { name: 'Войти и добавить' }));
    expect(onBeforeLogin).toHaveBeenCalledTimes(1);
  });
});
