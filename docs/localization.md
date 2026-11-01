# Localization

## Contract

- Supported locales: `en` and `ru`.
- Default locale: `en`.
- Russian is fully supported, not a fallback.
- Source code comments and public engineering documentation use English.

## How it works

- Library: [next-intl](https://next-intl.dev) without locale routing. URLs carry no locale.
- The locale lives in the `NEXT_LOCALE` cookie (`src/i18n/config.ts`, `src/i18n/request.ts`):
  a saved choice wins, otherwise the first supported language of `Accept-Language`, otherwise
  English. Server components render the chosen language on the first response, so there is no
  flash of the other language.
- The switcher in the header (`src/components/LanguageSwitcher.tsx`) stores the cookie through a
  server action and refreshes the page in place.
- `<html lang>` follows the locale.

## Messages

- One JSON file per namespace and language: `src/i18n/messages/{ru,en}/<namespace>.json`
  (`common`, `nav`, `auth`, `home`, `catalog`, `lists`, `history`, `admin`, `api`, `email`).
- Keys are typed from the Russian dictionary (`src/i18n/next-intl.d.ts`): an unknown key or a key
  missing in English fails the type check.
- `src/i18n/messages.test.ts` checks that both languages have the same keys, the same ICU
  arguments, no empty messages and no Cyrillic in English.
- ICU syntax for parameters and plurals (Russian: one/few/many/other, English: one/other). Dates
  and numbers go through next-intl formatters.
- Client components: `useTranslations('<namespace>')`; server components and route handlers:
  `getTranslations` / `getLocale` from `next-intl/server`.
- Component tests render through `renderWithIntl` (`src/test/intl.tsx`), Russian by default.

## Catalogue data

- Products, variants and categories keep the Russian name in `name` and the English one in
  `nameEn`; `localizedName(entity, locale)` (`src/lib/catalog-name.ts`) picks one, English falling
  back to Russian.
- Pictures with text on the packaging have an English version in `products.imageUrlEn`;
  `productImageUrl(product, locale)` (`src/lib/product-image.ts`) uses it in English and keeps the
  main picture otherwise. Text-free pictures are shared by both languages.
- History snapshots copy the English names and picture next to the Russian ones.
- Search (`src/lib/services/product-search.ts`) finds products by either language and ranks
  matches in the interface language first.
- AI tools keep the shopper's own word in its language (Russian in `nameRu`, English in
  `nameEn`) and translate only the other field.
- The data stays in per-language columns rather than a translations table: there are two
  languages, search indexes both columns directly, and every read goes through the two helpers
  above, so moving to a table later only changes those helpers and the queries.

## Not localized yet

- `manifest.json` and `offline.html` are static English files.
- Names of the default lists created for a new user are created in the user's language at that
  moment and are not translated later (they are user data afterwards).
