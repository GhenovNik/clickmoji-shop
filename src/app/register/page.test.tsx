import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test/intl';
import RegisterPage from './page';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const auth = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next-auth/react', () => ({ signIn: auth.signIn }));

function submit(password: string, confirmPassword = password) {
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'user@example.com' } });
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
  router.push.mockReset();
  router.refresh.mockReset();
  auth.signIn.mockReset();
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
    expect(screen.getByPlaceholderText('Минимум 8 символов')).toBeTruthy();
  });

  it('renders the form and the password rules in English', async () => {
    renderWithIntl(<RegisterPage />, { locale: 'en' });

    expect(screen.getByRole('heading', { name: /Sign up/ })).toBeTruthy();
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
