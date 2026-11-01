'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { setLocale } from '@/i18n/actions';
import { locales } from '@/i18n/config';
import { cn } from '@/lib/utils';

// Both dictionaries are on the server: switching stores the cookie and re-renders the page in
// place, without a navigation or a full reload.
export default function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations('nav');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div
      role="group"
      aria-label={t('switchLanguage')}
      className={cn(
        'flex rounded-lg border border-gray-200 p-0.5 text-xs',
        pending && 'opacity-60'
      )}
    >
      {locales.map((value) => (
        <button
          key={value}
          type="button"
          lang={value}
          aria-pressed={value === locale}
          disabled={pending}
          onClick={() => {
            if (value === locale) return;
            startTransition(async () => {
              await setLocale(value);
              router.refresh();
            });
          }}
          className={cn(
            'px-2 py-1 rounded-md font-semibold uppercase transition-colors',
            value === locale ? 'bg-primary text-white' : 'text-gray-600 hover:text-gray-900'
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
