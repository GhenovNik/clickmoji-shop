import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl } from '@/test/intl';
import { messages } from '@/i18n/messages';
import type { Locale } from '@/i18n/config';

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  pathname: '/categories',
  search: new URLSearchParams(),
}));

const auth = vi.hoisted(() => ({
  session: {
    data: { user: { id: 'u1', email: 'user@example.com', name: 'Alice', role: 'USER' } } as unknown,
    status: 'authenticated' as 'authenticated' | 'loading' | 'unauthenticated',
  },
  signOut: vi.fn(),
}));

const intlServer = vi.hoisted(() => ({
  locale: 'ru' as Locale,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.search,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => auth.session,
  signOut: auth.signOut,
  signIn: vi.fn(),
  getProviders: vi.fn(async () => ({})),
}));

vi.mock('next-intl/server', () => ({
  getLocale: async () => intlServer.locale,
  getTranslations: async (namespace: keyof (typeof messages)['ru']) =>
    createTranslator({
      locale: intlServer.locale,
      messages: messages[intlServer.locale],
      namespace,
    }),
}));

import AccountPage from './page';
import RegisterPage from '@/app/register/page';
import UserMenu from '@/components/UserMenu';
import MobileNav from '@/components/layout/MobileNav';
import SiteFooter from '@/components/layout/SiteFooter';
import TermsPage from '@/app/terms/page';
import PrivacyPage from '@/app/privacy/page';
import LoginPage from '@/app/login/page';

function mockProfileFetch(hasPassword = true, isGuest = false) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/account' && (!init?.method || init.method === 'GET')) {
      return Response.json({
        user: {
          id: 'u1',
          email: 'user@example.com',
          name: 'Alice',
          role: 'USER',
          createdAt: '2026-11-20T10:00:00.000Z',
          hasPassword,
          isGuest,
        },
      });
    }
    if (url === '/api/account/password') {
      return Response.json({ success: true, message: 'Password updated' });
    }
    if (url === '/api/account' && init?.method === 'DELETE') {
      return Response.json({ success: true, message: 'Account deleted' });
    }
    return Response.json({}, { status: 404 });
  });
}

beforeEach(() => {
  nav.push.mockReset();
  nav.refresh.mockReset();
  auth.signOut.mockReset().mockResolvedValue(undefined);
  auth.session = {
    data: { user: { id: 'u1', email: 'user@example.com', name: 'Alice', role: 'USER' } },
    status: 'authenticated',
  };
  intlServer.locale = 'ru';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountPage', () => {
  it.each(['ru', 'en'] as const)(
    'renders profile, password form and deletion, without export or documents, in %s',
    async (locale) => {
      vi.stubGlobal('fetch', mockProfileFetch(true));
      renderWithIntl(<AccountPage />, { locale });

      const headingText = locale === 'ru' ? /Аккаунт/ : /Account/;
      expect(await screen.findByRole('heading', { name: headingText })).toBeTruthy();
      expect(screen.getByText('user@example.com')).toBeTruthy();
      expect(screen.getByText(messages[locale].account.page.subtitle)).toBeTruthy();
      expect(document.getElementById('currentPassword')).toBeTruthy();
      expect(document.getElementById('deletePassword')).toBeTruthy();
      expect(screen.getByText(messages[locale].account.delete.description)).toBeTruthy();
      // The data export and the documents section are gone from the account page.
      expect(screen.queryByRole('button', { name: /JSON/ })).toBeNull();
      expect(screen.queryByRole('link', { name: messages[locale].legal.links.terms })).toBeNull();
      expect(screen.queryByRole('link', { name: messages[locale].legal.links.privacy })).toBeNull();
      expect(document.querySelector('[href="/api/account/export"]')).toBeNull();
    }
  );

  it.each(['ru', 'en'] as const)(
    'explains Google sign-in without local password and uses confirmation phrase in %s',
    async (locale) => {
      vi.stubGlobal('fetch', mockProfileFetch(false));
      renderWithIntl(<AccountPage />, { locale });

      expect(
        await screen.findByText(messages[locale].account.password.googleNoticeBody)
      ).toBeTruthy();
      expect(document.getElementById('currentPassword')).toBeNull();
      expect(document.getElementById('deleteConfirmation')).toBeTruthy();
      expect(screen.getByPlaceholderText(messages[locale].account.delete.phraseWord)).toBeTruthy();
    }
  );

  it.each(['ru', 'en'] as const)(
    'labels a server guest as Guest and hides password change and deletion in %s',
    async (locale) => {
      vi.stubGlobal('fetch', mockProfileFetch(false, true));
      renderWithIntl(<AccountPage />, { locale });

      expect(
        await screen.findByText(messages[locale].account.profile.signInMethodGuest)
      ).toBeTruthy();
      expect(screen.queryByText(messages[locale].account.profile.signInMethodGoogle)).toBeNull();
      expect(screen.queryByText(messages[locale].account.password.title)).toBeNull();
      expect(screen.queryByText(messages[locale].account.password.googleNoticeBody)).toBeNull();
      expect(screen.queryByText(messages[locale].account.delete.title)).toBeNull();
      expect(screen.queryByText(messages[locale].account.delete.description)).toBeNull();
      expect(document.getElementById('currentPassword')).toBeNull();
      expect(document.getElementById('deleteConfirmation')).toBeNull();
      expect(document.getElementById('deletePassword')).toBeNull();
      // The profile itself stays visible to the guest.
      expect(screen.getByText('user@example.com')).toBeTruthy();
    }
  );

  it.each(['ru', 'en'] as const)(
    'keeps a passwordless Google user on Google, with the notice and phrase deletion, in %s',
    async (locale) => {
      vi.stubGlobal('fetch', mockProfileFetch(false, false));
      renderWithIntl(<AccountPage />, { locale });

      expect(
        await screen.findByText(messages[locale].account.profile.signInMethodGoogle)
      ).toBeTruthy();
      expect(screen.queryByText(messages[locale].account.profile.signInMethodGuest)).toBeNull();
      expect(screen.getByText(messages[locale].account.password.googleNoticeBody)).toBeTruthy();
      expect(screen.getByText(messages[locale].account.delete.title)).toBeTruthy();
      expect(document.getElementById('deleteConfirmation')).toBeTruthy();
    }
  );

  it('submits password change and shows server feedback', async () => {
    const fetchMock = mockProfileFetch(true);
    vi.stubGlobal('fetch', fetchMock);
    renderWithIntl(<AccountPage />, { locale: 'en' });

    await screen.findByText('user@example.com');
    fireEvent.change(document.getElementById('currentPassword')!, {
      target: { value: 'OldPass123' },
    });
    fireEvent.change(document.getElementById('newPassword')!, {
      target: { value: 'NewPass456' },
    });
    fireEvent.change(document.getElementById('confirmNewPassword')!, {
      target: { value: 'NewPass456' },
    });
    fireEvent.submit(document.getElementById('currentPassword')!.closest('form')!);

    expect(await screen.findByText('Password updated')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'OldPass123', newPassword: 'NewPass456' }),
      })
    );
  });

  it('signs out and redirects after account deletion', async () => {
    const fetchMock = mockProfileFetch(true);
    vi.stubGlobal('fetch', fetchMock);
    renderWithIntl(<AccountPage />, { locale: 'en' });

    await screen.findByText('user@example.com');
    fireEvent.change(document.getElementById('deletePassword')!, {
      target: { value: 'OldPass123' },
    });
    fireEvent.submit(document.getElementById('deletePassword')!.closest('form')!);

    expect(await screen.findByText('Account deleted')).toBeTruthy();
    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith({ redirect: false }));
    expect(nav.push).toHaveBeenCalledWith('/login?deleted=true');
  });
});

describe('Navigation, registration links, footer and legal stubs', () => {
  it('links to /account from UserMenu and MobileNav in RU and EN', () => {
    for (const locale of ['ru', 'en'] as const) {
      const menu = renderWithIntl(<UserMenu />, { locale });
      const menuLink = screen.getByRole('link', { name: messages[locale].nav.account });
      expect(menuLink).toHaveAttribute('href', '/account');
      menu.unmount();

      const mobile = renderWithIntl(<MobileNav />, { locale });
      const mobileLink = screen.getByRole('link', { name: messages[locale].nav.account });
      expect(mobileLink).toHaveAttribute('href', '/account');
      mobile.unmount();
    }
  });

  it('shows legal links in RegisterPage and SiteFooter without using <nav> in footer', () => {
    const reg = renderWithIntl(<RegisterPage />, { locale: 'ru' });
    expect(screen.getByRole('link', { name: 'Условия использования' })).toHaveAttribute(
      'href',
      '/terms'
    );
    expect(screen.getByRole('link', { name: 'Политика конфиденциальности' })).toHaveAttribute(
      'href',
      '/privacy'
    );
    reg.unmount();

    const footer = renderWithIntl(<SiteFooter />, { locale: 'en' });
    expect(document.querySelector('footer')).toBeTruthy();
    expect(document.querySelector('nav')).toBeNull();
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      '/terms'
    );
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy'
    );
    footer.unmount();
  });

  it.each(['ru', 'en'] as const)('renders /terms and /privacy stubs in %s', (locale) => {
    const expectedBadge = locale === 'ru' ? 'Текст готовится' : 'Text is being prepared';

    const terms = renderWithIntl(<TermsPage />, { locale });
    expect(screen.getByText(expectedBadge)).toBeTruthy();
    terms.unmount();

    const privacy = renderWithIntl(<PrivacyPage />, { locale });
    expect(screen.getByText(expectedBadge)).toBeTruthy();
    privacy.unmount();
  });

  it.each(['ru', 'en'] as const)(
    'shows deleted account banner on /login?deleted=true in %s',
    (locale) => {
      nav.search = new URLSearchParams('deleted=true');
      const view = renderWithIntl(<LoginPage />, { locale });
      expect(screen.getByText(messages[locale].auth.login.accountDeleted)).toBeTruthy();
      view.unmount();
      nav.search = new URLSearchParams();
    }
  );
});
