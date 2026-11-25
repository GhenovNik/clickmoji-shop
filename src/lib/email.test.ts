// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { buildPasswordResetEmail, buildVerificationEmail } from './email';

// Emails go out in the language of the request that triggered them.

const request = { email: 'user@example.com', token: 'tok123' };

describe('buildVerificationEmail', () => {
  it('writes the confirmation email in English', () => {
    const content = buildVerificationEmail({ ...request, locale: 'en' });

    expect(content.subject).toBe('Confirm your email for ClickMoji');
    expect(content.text).toMatch(/^Confirm your email with this link: http.*\/api\/auth\/verify\?/);
    expect(content.text).toContain('token=tok123');
    expect(content.html).toContain('Welcome to ClickMoji');
    expect(content.html).toContain('>Confirm email</a>');
    expect(content.html).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('writes the confirmation email in Russian', () => {
    const content = buildVerificationEmail({ ...request, locale: 'ru' });

    expect(content.subject).toBe('Подтвердите email в ClickMoji');
    expect(content.html).toContain('Добро пожаловать в ClickMoji');
  });
});

describe('buildPasswordResetEmail', () => {
  it('writes the reset email in English with the link and its lifetime', () => {
    const content = buildPasswordResetEmail({ ...request, locale: 'en' });

    expect(content.subject).toBe('Reset your ClickMoji password');
    expect(content.text).toMatch(/^Password reset link: http.*\/reset-password\?/);
    expect(content.html).toContain('The link is valid for 1 hour.');
    expect(content.html).toContain('If the button does not work, open this link: http');
    expect(content.html).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('writes the reset email in Russian', () => {
    const content = buildPasswordResetEmail({ ...request, locale: 'ru' });

    expect(content.subject).toBe('Сброс пароля в ClickMoji');
    expect(content.html).toContain('Ссылка действует 1 час.');
  });
});

describe('email sender', () => {
  it.each(['sender@example.com', 'Old Display Name <sender@example.com>'])(
    'uses the public brand with the configured address (%s)',
    async (configuredSender) => {
      const send = vi.fn().mockResolvedValue({});
      vi.doMock('resend', () => ({
        Resend: class {
          emails = { send };
        },
      }));
      vi.stubEnv('RESEND_API_KEY', 'fixture');
      vi.stubEnv('RESEND_FROM_EMAIL', configuredSender);
      vi.resetModules();
      try {
        const { sendVerificationEmail } = await import('./email');
        await sendVerificationEmail({ ...request, locale: 'en' });
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ from: 'ClickMoji <sender@example.com>', to: request.email })
        );
      } finally {
        vi.doUnmock('resend');
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    }
  );
});
