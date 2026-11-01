import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import type { Locale } from '@/i18n/config';
import { messages } from '@/i18n/messages';

// Components read their copy through next-intl; tests render them in Russian unless they
// check the English UI.
export function renderWithIntl(
  ui: ReactElement,
  { locale = 'ru', ...options }: RenderOptions & { locale?: Locale } = {}
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
        {children}
      </NextIntlClientProvider>
    ),
    ...options,
  });
}
