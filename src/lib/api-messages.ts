import { headers } from 'next/headers';
import type { Locale } from '@/i18n/config';
import type { Messages } from '@/i18n/messages';
import { getRequestLocale, getServerTranslator, localeFromHeaders } from '@/lib/auth-security';

export type ApiMessageKey = keyof Messages['api']['errors'];

// The language of the current API request: from the Request when the handler has it, otherwise
// from the request scope's headers (auth guards). Outside a request (scripts, unit tests) there
// is no language to follow, so the text is English.
async function currentLocale(request?: Request): Promise<Locale> {
  if (request) return getRequestLocale(request);
  try {
    return localeFromHeaders(await headers());
  } catch {
    return 'en';
  }
}

/** A user-facing API error or message in the language of the request. */
export async function apiText(
  request: Request | undefined,
  key: ApiMessageKey,
  values?: Record<string, string | number>
) {
  return getServerTranslator(await currentLocale(request))(`api.errors.${key}`, values);
}
