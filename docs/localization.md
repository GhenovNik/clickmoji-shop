# Localization Direction

## Current state

- The application UI currently contains inline Russian copy.
- Database catalog entities already store Russian and English names through `name` and `nameEn`.
- The document language remains `ru` until the visible application copy is fully extracted and an
  English catalog experience is available.
- Source code comments and public engineering documentation use English.

## Target contract

- Supported locales: `en` and `ru`.
- Default locale: `en`.
- Russian remains fully supported rather than being treated as fallback content.
- Locale selection must be explicit, persistent, accessible, and covered by desktop/mobile browser
  tests.
- URLs, metadata, validation messages, transactional email, PWA metadata, and catalog fields must
  resolve through the same locale contract.

## Migration boundary

Localization should be implemented as one coherent migration. Partially translating individual
screens would create mixed-language flows and incorrect accessibility metadata. The implementation
slice therefore includes:

1. Select and configure the App Router localization library and URL strategy.
2. Extract user-visible copy into typed message catalogs.
3. Add English and Russian messages with English as the default.
4. Resolve localized catalog names consistently in server and client components.
5. Add a language switcher and persist the user's selection.
6. Localize metadata, auth emails, API validation copy, manifest/offline content, and error states.
7. Add locale parity checks plus desktop/mobile E2E coverage.

Until that slice is complete, documentation must describe the UI as Russian-first rather than
claiming unsupported English behavior.
