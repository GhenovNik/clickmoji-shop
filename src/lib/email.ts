import { Resend } from 'resend';
import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/config';
import { messages } from '@/i18n/messages';
import { getAppBaseUrl } from './app-url';

const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL;
const appUrl = getAppBaseUrl();

const resend = resendApiKey ? new Resend(resendApiKey) : null;

export type EmailContent = { subject: string; text: string; html: string };

// Every email goes out in the language of the request that triggered it.
type EmailRequest = { email: string; token: string; locale: Locale };

export function isEmailServiceConfigured(): boolean {
  return Boolean(resendApiKey && resendFromEmail);
}

export function isEmailVerificationRequired(): boolean {
  const override = process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
  if (override === 'true') return true;
  if (override === 'false') return false;
  return isEmailServiceConfigured();
}

function emailTranslator(locale: Locale) {
  return createTranslator({ locale, messages: messages[locale], namespace: 'email' });
}

function linkWithCredentials(path: string, { email, token }: { email: string; token: string }) {
  const url = new URL(path, appUrl);
  url.searchParams.set('token', token);
  url.searchParams.set('email', email);
  return url.toString();
}

export function buildVerificationEmail({ email, token, locale }: EmailRequest): EmailContent {
  const t = emailTranslator(locale);
  const verifyUrl = linkWithCredentials('/api/auth/verify', { email, token });

  return {
    subject: t('verification.subject'),
    text: t('verification.text', { url: verifyUrl }),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
        <h2 style="margin: 0 0 12px;">${t('verification.heading')}</h2>
        <p style="margin: 0 0 16px;">${t('verification.intro')}</p>
        <p style="margin: 0 0 24px;">
          <a href="${verifyUrl}" style="background: #2563eb; color: #fff; padding: 10px 16px; border-radius: 8px; text-decoration: none;">${t('verification.button')}</a>
        </p>
        <p style="margin: 0; font-size: 13px; color: #555;">${t('fallbackLink', { url: verifyUrl })}</p>
      </div>
    `,
  };
}

export function buildPasswordResetEmail({ email, token, locale }: EmailRequest): EmailContent {
  const t = emailTranslator(locale);
  const resetUrl = linkWithCredentials('/reset-password', { email, token });

  return {
    subject: t('passwordReset.subject'),
    text: t('passwordReset.text', { url: resetUrl }),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
        <h2 style="margin: 0 0 12px;">${t('passwordReset.heading')}</h2>
        <p style="margin: 0 0 16px;">${t('passwordReset.intro')}</p>
        <p style="margin: 0 0 24px;">
          <a href="${resetUrl}" style="background: #2563eb; color: #fff; padding: 10px 16px; border-radius: 8px; text-decoration: none;">${t('passwordReset.button')}</a>
        </p>
        <p style="margin: 0 0 12px; font-size: 13px; color: #555;">${t('passwordReset.expiry')}</p>
        <p style="margin: 0; font-size: 13px; color: #555;">${t('fallbackLink', { url: resetUrl })}</p>
      </div>
    `,
  };
}

async function send(email: string, content: EmailContent) {
  if (!resend || !resendFromEmail) {
    throw new Error('Resend is not configured');
  }

  await resend.emails.send({ from: resendFromEmail, to: email, ...content });
}

export async function sendVerificationEmail(request: EmailRequest) {
  await send(request.email, buildVerificationEmail(request));
}

export async function sendPasswordResetEmail(request: EmailRequest) {
  await send(request.email, buildPasswordResetEmail(request));
}
