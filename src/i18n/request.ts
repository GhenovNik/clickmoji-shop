import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE, resolveLocale } from './config';
import { messages } from './messages';

// No locale in the URL: the language lives in a cookie, so the server renders the chosen
// language on the first byte and switching is a refresh, not a navigation.
export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerList.get('accept-language')
  );

  return {
    locale,
    messages: messages[locale],
    timeZone: 'UTC',
  };
});
