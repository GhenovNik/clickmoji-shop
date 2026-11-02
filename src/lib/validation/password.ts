import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/config';
import enAuth from '@/i18n/messages/en/auth.json';
import ruAuth from '@/i18n/messages/ru/auth.json';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

// Stable codes, so the same rule runs in the browser and on the server and each side
// translates it: t(`password.${issue}`, PASSWORD_MESSAGE_VALUES) in the auth namespace.
export type PasswordIssue = 'required' | 'tooShort' | 'tooLong' | 'noLetter' | 'noDigit';

export const PASSWORD_MESSAGE_VALUES = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };

// Latin or Russian letters (U+0410..U+044F, the same range as before).
const LETTER = /[A-Za-z\u0410-\u044F]/;

export function getPasswordIssue(password: string): PasswordIssue | null {
  if (!password) return 'required';
  if (password.length < PASSWORD_MIN_LENGTH) return 'tooShort';
  if (password.length > PASSWORD_MAX_LENGTH) return 'tooLong';
  if (!LETTER.test(password)) return 'noLetter';
  if (!/\d/.test(password)) return 'noDigit';
  return null;
}

const authMessages = { ru: ruAuth, en: enAuth };

/**
 * The issue as a sentence in the given language. Callers that have not passed a locale yet keep
 * the Russian text they always got.
 */
export function getPasswordValidationError(password: string, locale: Locale = 'ru') {
  const issue = getPasswordIssue(password);
  if (!issue) return null;

  const t = createTranslator({
    locale,
    messages: { auth: authMessages[locale] },
    namespace: 'auth.password',
  });
  return t(issue, PASSWORD_MESSAGE_VALUES);
}
