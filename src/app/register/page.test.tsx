import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '@/test/intl';
import RegisterPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function submit(password: string, confirmPassword = password) {
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'user@example.com' } });
  fireEvent.change(document.getElementById('password')!, { target: { value: password } });
  fireEvent.change(document.getElementById('confirmPassword')!, {
    target: { value: confirmPassword },
  });
  fireEvent.submit(document.querySelector('form')!);
}

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
});
