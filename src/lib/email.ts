import { Resend } from 'resend';
import { getAppBaseUrl } from './app-url';

const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL;
const appUrl = getAppBaseUrl();

const resend = resendApiKey ? new Resend(resendApiKey) : null;

export function isEmailServiceConfigured(): boolean {
  return Boolean(resendApiKey && resendFromEmail);
}

export function isEmailVerificationRequired(): boolean {
  const override = process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
  if (override === 'true') return true;
  if (override === 'false') return false;
  return isEmailServiceConfigured();
}

export async function sendVerificationEmail({ email, token }: { email: string; token: string }) {
  if (!resend || !resendFromEmail) {
    throw new Error('Resend is not configured');
  }

  const verifyUrl = new URL('/api/auth/verify', appUrl);
  verifyUrl.searchParams.set('token', token);
  verifyUrl.searchParams.set('email', email);

  const subject = 'Подтвердите email в Clickmoji Shop';
  const text = `Подтвердите email по ссылке: ${verifyUrl.toString()}`;

  await resend.emails.send({
    from: resendFromEmail,
    to: email,
    subject,
    text,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
        <h2 style="margin: 0 0 12px;">Добро пожаловать в Clickmoji Shop</h2>
        <p style="margin: 0 0 16px;">Подтвердите email, чтобы войти в аккаунт.</p>
        <p style="margin: 0 0 24px;">
          <a href="${verifyUrl.toString()}" style="background: #2563eb; color: #fff; padding: 10px 16px; border-radius: 8px; text-decoration: none;">Подтвердить email</a>
        </p>
        <p style="margin: 0; font-size: 13px; color: #555;">Если кнопка не работает, откройте ссылку: ${verifyUrl.toString()}</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail({ email, token }: { email: string; token: string }) {
  if (!resend || !resendFromEmail) {
    throw new Error('Resend is not configured');
  }

  const resetUrl = new URL('/reset-password', appUrl);
  resetUrl.searchParams.set('token', token);
  resetUrl.searchParams.set('email', email);

  const subject = 'Сброс пароля в Clickmoji Shop';
  const text = `Ссылка для сброса пароля: ${resetUrl.toString()}`;

  await resend.emails.send({
    from: resendFromEmail,
    to: email,
    subject,
    text,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
        <h2 style="margin: 0 0 12px;">Сброс пароля</h2>
        <p style="margin: 0 0 16px;">Вы запросили смену пароля в Clickmoji Shop.</p>
        <p style="margin: 0 0 24px;">
          <a href="${resetUrl.toString()}" style="background: #2563eb; color: #fff; padding: 10px 16px; border-radius: 8px; text-decoration: none;">Сменить пароль</a>
        </p>
        <p style="margin: 0 0 12px; font-size: 13px; color: #555;">Ссылка действует 1 час.</p>
        <p style="margin: 0; font-size: 13px; color: #555;">Если кнопка не работает, откройте ссылку: ${resetUrl.toString()}</p>
      </div>
    `,
  });
}
