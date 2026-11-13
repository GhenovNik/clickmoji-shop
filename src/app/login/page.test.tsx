import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import LoginPage from './page';
import { renderWithIntl } from '@/test/intl';

// AGE-1618 AC-2/AC-3: after a successful sign-in the guest returns to the page the login
// link pointed at; an absent or off-site callbackUrl falls back to the home page.

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  search: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
  useSearchParams: () => nav.search,
  usePathname: () => '/login',
}));

const nextauth = vi.hoisted(() => ({
  signIn: vi.fn(),
  getProviders: vi.fn(),
}));
vi.mock('next-auth/react', () => ({
  signIn: nextauth.signIn,
  getProviders: nextauth.getProviders,
}));

beforeEach(() => {
  nav.push.mockReset();
  nav.refresh.mockReset();
  nav.search = new URLSearchParams('callbackUrl=/categories/c1/products');
  nextauth.signIn.mockReset();
  nextauth.signIn.mockResolvedValue({ error: null });
  nextauth.getProviders.mockReset();
  nextauth.getProviders.mockResolvedValue({ google: { id: 'google' } });
});

function fillAndSubmit(container: HTMLElement) {
  const email = container.querySelector('input[name="email"]');
  const password = container.querySelector('input[name="password"]');
  const form = container.querySelector('form');
  if (!email || !password || !form) throw new Error('login form is not rendered');
  fireEvent.change(email, { target: { value: 'guest@example.com' } });
  fireEvent.change(password, { target: { value: 'secret-password' } });
  fireEvent.submit(form);
}

describe('the login page return address', () => {
  it('sends a guest who signs in with a password back to the callbackUrl (AC-2)', async () => {
    const { container } = renderWithIntl(<LoginPage />);
    fillAndSubmit(container);

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/categories/c1/products'));
    expect(nextauth.signIn).toHaveBeenCalledWith('credentials', {
      email: 'guest@example.com',
      password: 'secret-password',
      redirect: false,
    });
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('passes the callbackUrl to Google sign-in (AC-2)', async () => {
    renderWithIntl(<LoginPage />);
    const googleButton = await screen.findByRole('button', { name: 'Войти через Google' });
    fireEvent.click(googleButton);

    await waitFor(() =>
      expect(nextauth.signIn).toHaveBeenCalledWith('google', {
        callbackUrl: '/categories/c1/products',
      })
    );
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', ''])(
    'falls back to / for %j after a password sign-in (AC-3)',
    async (callbackUrl) => {
      nav.search = new URLSearchParams(`callbackUrl=${callbackUrl}`);
      const { container } = renderWithIntl(<LoginPage />);
      fillAndSubmit(container);

      await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/'));
    }
  );

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', ''])(
    'falls back to / for %j on Google sign-in (AC-3)',
    async (callbackUrl) => {
      nav.search = new URLSearchParams(`callbackUrl=${callbackUrl}`);
      renderWithIntl(<LoginPage />);
      const googleButton = await screen.findByRole('button', { name: 'Войти через Google' });
      fireEvent.click(googleButton);

      await waitFor(() =>
        expect(nextauth.signIn).toHaveBeenCalledWith('google', { callbackUrl: '/' })
      );
    }
  );

  it('falls back to / when the parameter is missing (AC-3)', async () => {
    nav.search = new URLSearchParams();
    const { container } = renderWithIntl(<LoginPage />);
    fillAndSubmit(container);

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/'));
  });
});
