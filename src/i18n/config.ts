export const locales = ['ru', 'en'] as const;
export type Locale = (typeof locales)[number];

// The docs/localization.md contract: English by default, Russian fully supported. A visitor
// without a saved choice gets the first supported language of the browser.
export const defaultLocale: Locale = 'en';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null) {
  if (isLocale(cookieValue)) return cookieValue;

  const preferred = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((param) => param.trim().startsWith('q='));
      return {
        language: tag.trim().toLowerCase().split('-')[0],
        q: q ? Number(q.split('=')[1]) : 1,
      };
    })
    .filter((entry) => entry.language && !Number.isNaN(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  return preferred.map((entry) => entry.language).find(isLocale) ?? defaultLocale;
}
