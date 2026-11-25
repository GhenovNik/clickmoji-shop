import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test/intl';
import RegisterPage from './page';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const auth = vi.hoisted(() => ({
  signIn: vi.fn(),
  getProviders: vi.fn(async () => ({
    google: { id: 'google' },
  })),
  session: null as null | { user: { isGuest: boolean } },
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next-auth/react', () => ({
  signIn: auth.signIn,
  getProviders: auth.getProviders,
  useSession: () => ({
    data: auth.session,
    status: auth.session ? 'authenticated' : 'unauthenticated',
  }),
}));

function submit(password: string, confirmPassword = password) {
  fireEvent.change(document.getElementById('email')!, { target: { value: 'user@example.com' } });
  fireEvent.change(document.getElementById('password')!, { target: { value: password } });
  fireEvent.change(document.getElementById('confirmPassword')!, {
    target: { value: confirmPassword },
  });
  fireEvent.submit(document.querySelector('form')!);
}

function stubRegister(response: Record<string, unknown>, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(response, { status: ok ? 200 : 400 }))
  );
}

beforeEach(() => {
  auth.getProviders.mockReset();
  auth.getProviders.mockResolvedValue({
    google: { id: 'google' },
  });
  window.history.replaceState({}, '', '/register');
  router.push.mockReset();
  router.refresh.mockReset();
  auth.signIn.mockReset();
  auth.session = null;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RegisterPage', () => {
  it('renders the form in Russian by default', () => {
    renderWithIntl(<RegisterPage />);

    expect(screen.getByRole('heading', { name: /Регистрация/ })).toBeTruthy();
    expect(screen.getByLabelText('Электронная почта')).toBeTruthy();
    expect(screen.getByPlaceholderText('Минимум 8 символов')).toBeTruthy();
  });

  it('explains list retention to a guest, in both locales', () => {
    auth.session = { user: { isGuest: true } };
    const { unmount } = renderWithIntl(<RegisterPage />);
    expect(screen.getByText(/Ваши списки, покупки и избранное сохранятся/)).toBeTruthy();
    unmount();

    renderWithIntl(<RegisterPage />, { locale: 'en' });
    expect(screen.getByText(/Your lists, purchases and favorites will be kept/)).toBeTruthy();
  });

  it('shows no guest notice to a signed-out visitor', () => {
    renderWithIntl(<RegisterPage />);
    expect(screen.queryByText(/сохранятся/)).toBeNull();
  });

  it('renders the form and the password rules in English', async () => {
    renderWithIntl(<RegisterPage />, { locale: 'en' });

    expect(screen.getByRole('heading', { name: /Sign up/ })).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByPlaceholderText('At least 8 characters')).toBeTruthy();

    submit('abc1');
    expect(await screen.findByText('Password must be at least 8 characters')).toBeTruthy();
  });

  it('reports mismatching passwords in English', async () => {
    renderWithIntl(<RegisterPage />, { locale: 'en' });

    submit('abcdefg1', 'abcdefg2');
    expect(await screen.findByText('Passwords do not match')).toBeTruthy();
  });

  it('signs in automatically and goes home when verification is not required', async () => {
    stubRegister({ ok: true, requiresEmailVerification: false });
    auth.signIn.mockResolvedValue({ error: undefined });

    renderWithIntl(<RegisterPage />, { locale: 'en' });
    submit('password1');

    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(auth.signIn).toHaveBeenCalledWith('credentials', {
      email: 'user@example.com',
      password: 'password1',
      redirect: false,
    });
    expect(router.push).toHaveBeenCalledWith('/');
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not sign in when verification is required', async () => {
    stubRegister({ ok: true, requiresEmailVerification: true });

    renderWithIntl(<RegisterPage />, { locale: 'en' });
    submit('password1');

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login?registered=verify'));
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('falls back to manual login when the automatic sign-in returns an error', async () => {
    stubRegister({ ok: true, requiresEmailVerification: false });
    auth.signIn.mockResolvedValue({ error: 'CredentialsSignin' });

    renderWithIntl(<RegisterPage />, { locale: 'en' });
    submit('password1');

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login?registered=auto'));
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('falls back to manual login when the automatic sign-in throws', async () => {
    stubRegister({ ok: true, requiresEmailVerification: false });
    auth.signIn.mockRejectedValue(new Error('network down'));

    renderWithIntl(<RegisterPage />, { locale: 'en' });
    submit('password1');

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/login?registered=auto'));
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('never puts the password into navigation targets or web storage', async () => {
    stubRegister({ ok: true, requiresEmailVerification: false });
    auth.signIn.mockResolvedValue({ error: undefined });

    renderWithIntl(<RegisterPage />, { locale: 'en' });
    submit('password1');

    await waitFor(() => expect(router.push).toHaveBeenCalled());
    const pushed = router.push.mock.calls.flat().join(' ');
    expect(pushed).not.toContain('password1');
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        expect(storage.getItem(storage.key(i)!)).not.toContain('password1');
      }
    }
  });
});

// The server answers in the request language (cookie), and the form shows that text as it is.
// These texts are the same strings the register route returns; the route tests pin them.
describe('RegisterPage server errors in both languages', () => {
  function stubAnswer(status: number, body: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body, { status }))
    );
  }

  it.each([
    ['ru', 400, 'Некорректная электронная почта'],
    ['en', 400, 'Invalid email'],
    ['ru', 409, 'Пользователь с такой электронной почтой уже существует'],
    ['en', 409, 'A user with this email already exists'],
    ['ru', 429, 'Слишком много попыток. Попробуйте позже.'],
    ['en', 429, 'Too many attempts. Please try again later.'],
  ] as const)('shows the %s %i answer as the server wrote it', async (locale, status, text) => {
    stubAnswer(status, { error: text });

    renderWithIntl(<RegisterPage />, { locale });
    submit('password1');

    expect(await screen.findByText(text)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    ['ru', 'Ошибка сети'],
    ['en', 'Network error'],
  ] as const)('shows the %s network failure text', async (locale, text) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline')))
    );

    renderWithIntl(<RegisterPage />, { locale });
    submit('password1');

    expect(await screen.findByText(text)).toBeTruthy();
  });
});

describe('RegisterPage guest upgrade (AGE-1667)', () => {
  it('labels the guest submit as the save-account action, in both locales', () => {
    auth.session = { user: { isGuest: true } };
    const { unmount } = renderWithIntl(<RegisterPage />);
    expect(screen.getByRole('button', { name: 'Сохранить аккаунт' })).toBeTruthy();
    unmount();

    renderWithIntl(<RegisterPage />, { locale: 'en' });
    expect(screen.getByRole('button', { name: 'Save account' })).toBeTruthy();
  });

  it('keeps the ordinary sign-up label for a signed-out visitor', () => {
    renderWithIntl(<RegisterPage />);
    expect(screen.getByRole('button', { name: 'Зарегистрироваться' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Сохранить аккаунт через Google' })).toBeNull();
  });

  it('arms the server-side upgrade first, then starts the same google provider', async () => {
    auth.session = { user: { isGuest: true } };
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderWithIntl(<RegisterPage />, { locale: 'en' });

    fireEvent.click(await screen.findByRole('button', { name: 'Save account with Google' }));

    await waitFor(() => expect(auth.signIn).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/guest-upgrade', { method: 'POST' });
    // The upgrade is the same Google provider and redirect URI; the server-side arm makes it explicit.
    expect(auth.signIn).toHaveBeenCalledWith('google', { callbackUrl: '/' });
    expect(auth.signIn).not.toHaveBeenCalledWith('google-upgrade', expect.anything());
    // The intent lives only in the server's httpOnly cookie; the page never sets a browser flag.
    expect(document.cookie).not.toContain('clickmoji_guest_upgrade');
  });

  it('does not start Google when the guest is no longer live, and shows the expired notice', async () => {
    auth.session = { user: { isGuest: true } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'guestSessionExpired' }, { status: 409 }))
    );
    renderWithIntl(<RegisterPage />, { locale: 'en' });

    fireEvent.click(await screen.findByRole('button', { name: 'Save account with Google' }));

    expect(await screen.findByText(/Your guest session has expired/)).toBeTruthy();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('shows no Google upgrade button when Google is not configured', async () => {
    auth.session = { user: { isGuest: true } };
    auth.getProviders.mockResolvedValue({} as never);
    renderWithIntl(<RegisterPage />);

    await waitFor(() => expect(auth.getProviders).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /через Google/ })).toBeNull();
  });

  it.each([
    ['email-taken', 'ru', 'Эта почта уже зарегистрирована — войдите'],
    ['email-taken', 'en', 'This email is already registered — sign in'],
    ['unverified', 'ru', 'Google не подтвердил эту почту'],
    ['expired', 'en', 'Your guest session has expired. Start shopping again.'],
  ] as const)('shows the %s refusal from Google in %s', (reason, locale, text) => {
    window.history.replaceState({}, '', `/register?upgrade=${reason}`);

    renderWithIntl(<RegisterPage />, { locale });

    expect(screen.getByText(text, { exact: false })).toBeTruthy();
  });
});
