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
- Product, variant and history pictures are chosen by one pure function,
  `productImageUrl(picture, locale, options?)` (`src/lib/product-image.ts`), which the server and
  the browser run alike. Its input is the main picture (`imageUrl`), the language of its text
  (`imageTextLocale`: empty = unlabelled, `none` = no text, otherwise a language) and the dictionary
  `localizedImages` (`{"<language>": "<url>"}`). The picture languages are listed in
  `src/lib/image-languages.ts`; the five selection steps are tested in `product-image.test.ts`.
- `imageUrl` has no language of its own in the dictionary, but the dictionary may hold an entry for
  any listed language, the main one included: a product whose main picture carries another
  language's text keeps its Russian version in `localizedImages.ru`.
- `imageUrlEn` is a legacy mirror of the English dictionary entry, kept until AGE-1667 Ya6. It is
  write-only: every writer under `src` stores it next to the dictionary (the way back to the
  previous release), nothing under `src` reads it, and no response carries it: a query that serves
  a product, a variant or a history snapshot omits the column (`src/lib/catalog-omit.ts`, Prisma
  `omit`). The tooling that still reads it lives outside `src` (see the decisions below).
- History snapshots copy the English names and picture next to the Russian ones. Snapshots taken
  before this change keep only their Russian copy: they are not filled from today's catalogue. The
  English address of a product whose legacy column the previous release has written is taken from
  that column when its list is completed (see the transition protection below), so a snapshot
  holds what the catalogue showed at that moment and never depends on what it shows later.
- Search (`src/lib/services/product-search.ts`) finds products by either language and ranks
  matches in the interface language first.
- AI tools keep the shopper's own word in its language (Russian in `nameRu`, English in
  `nameEn`) and translate only the other field.
- The data stays in per-language columns rather than a translations table: there are two
  languages, search indexes both columns directly, and every read goes through the two helpers
  above, so moving to a table later only changes those helpers and the queries.

## Decisions (AGE-1667 Ya3, fix round)

- **One list, nothing else names a language.** `IMAGE_LANGUAGES` in `src/lib/image-languages.ts`
  is the only place a picture language is added. The admin form draws one picture field per listed
  language (the main language included), the library picker fills every listed language, the
  product API accepts edits for them, and the selector needs no list at all. A field's label
  falls back from the interface wording (English has its own) to the platform's language name
  (`Intl.DisplayNames`) to the upper-case code, so a new language needs no message and no type
  entry. `src/components/admin/image-language-list.test.tsx` adds an invented `xx` to the list
  only and checks the selector, the stored dictionary, the library grouping and the form.
- **The list limits edits, never data.** Entries of a language that is not (or not yet) listed
  survive every write: the product API applies the edit to the languages it names and keeps the
  rest as stored (`mergeLocalizedImages`), a history snapshot and a merged duplicate copy the whole
  dictionary, and the batch import changes only its `en` entry. An edit of an unlisted language is
  ignored, so a stale form can neither erase nor add one. Rows written before this change with a
  dictionary of unlisted languages keep them.
- **A save is an edit, not a copy of what the form shows.** `PUT /api/products/[id]` takes
  `localizedImages` as a per-language edit (`PictureEdit`): a string sets that language, `null`
  (or a blank string) removes it, and a language that is not in the edit is left as stored. The
  form (`ProductForm`) submits only the languages whose picture changed since it opened; the
  "custom image" box turned off removes the pictures the form showed, by name. The legacy English
  column is written only when English is in the edit (a new picture, or an explicit removal, both
  clear or set the mirror together with the dictionary). Why: the previous release writes
  `imageUrlEn` only, so a row can hold its sole English address there while the dictionary has
  none; the form cannot show it, and a save that "spoke for" every listed language would have
  mirrored the missing English entry into `null` and erased the address before the repeat
  backfill could copy it. An ordinary edit leaves the address for the backfill; an explicit removal
  clears both places, so the backfill finds nothing to bring back. A body whose `localizedImages`
  cannot be read changes no picture language. The dictionary is read and rewritten under a row lock
  (`SELECT ... FOR UPDATE`) in the same transaction as the variants, so a failed save leaves
  nothing and a repeated request ends in the same state.
- **Transition protection for writers that copy a picture set.** A history snapshot is taken once
  and never refilled from the catalogue, and a catalogue cleanup deletes the row it copies from, so
  neither can wait for the repeat backfill to bring an English address from the legacy column. The
  previous release writes that column alone, so until it is stopped and the backfill has run again
  the two English places of a row can disagree: the dictionary has no English entry (only the old
  column holds the address), the old writer replaced the address (A in the dictionary, B in the
  column), or it cleared it (A in the dictionary, null in the column). Two writers therefore take
  the English entry from the legacy column of the row they read, through one narrow helper outside
  `src`, `scripts/lib/legacy-picture-transition.ts` (the same arrangement as the deletion guard
  below). **The rule is the backfill's own (`planRow`): the legacy column is the source of the
  English entry, an explicit null included** (a null or blank column removes the dictionary's
  English entry, a filled one replaces it, every other language is kept as stored). This is sound
  because every English write of the new release stores the dictionary entry and the column
  together in one statement, so the two can differ only because the previous release wrote the
  column later, and the column is then the newer one: the product API (create, and an edit that
  names English; an edit of another language leaves the column alone), the catalogue cleanup, the
  batch import and the history snapshot. `withLegacyEnglish` and `planRow` are tested to give the
  same English entry in every state of the two places. An ordinary read never consults the column.
  A caller must read the column in the same statement as the rest of the row (no later lookup);
  `imageUrlEn: undefined` (not read) folds nothing.
  - **Completing a list** (`POST /api/history`). In the same transaction, the statement that
    already decides which products are visible to the user (`readVisibleSnapshotPictures`) also
    returns their main picture, its text language, the dictionary and the legacy English column,
    so all of them come from one database snapshot and the number of queries is unchanged. The
    helper returns the canonical dictionary of the rule above. The ordinary snapshot code
    (`historyPictureFields`) then copies that dictionary and mirrors its English entry into the
    snapshot's rollback column; the legacy value is never a field of a response or of any other
    read, and the application never reads it later to complete an old snapshot. A product that is
    not visible to the user is not read and is not copied, so it has no fallback either. A failed
    read rolls the whole completion back. Results: a legacy-only English entry, an address an old
    writer replaced, or one it cleared → switch → list completed → repeat backfill → catalogue
    changes: the history keeps what the old catalogue showed at completion (the address, B, or no
    English address) and never takes a later change (`legacy-picture-transition.test.ts` runs the
    two passes of the backfill around a completion in one scenario). Snapshots taken before this
    protection existed are not repaired from today's catalogue.
  - **Catalogue cleanup** (`src/lib/services/catalog-cleanup.ts`). The duplicate, the singular
    product it merges into, the product that becomes a variant and an existing variant that
    receives its picture are read through `withLegacyEnglish` before anything is moved or deleted.
    The main address and each language are decided apart, so a rule for one never decides the
    other:
    - the main address of a merge: the singular product's own wins; the duplicate's is taken (with
      its text language) only when the singular product has none, and the log names a duplicate's
      main address that was not kept (the operator's rule of 2026-11-01);
    - each language: an entry only the duplicate has moves over whether or not the main address
      does (the singular product's own languages stay, its legacy-only English address included);
      the same address on both sides is no conflict; **different addresses of one language stop the
      cleanup** (`Conflicting merge … : <language>`, `Conflicting variant …: <language>`) before the
      first row is moved or deleted, with both sides intact. Nothing is resolved by guessing: the
      operator edits one side and runs the cleanup again. The product that becomes a variant
      follows the same split (its main address against the variant's, then each language), and an
      entry of a language the picture list does not name travels and conflicts like any other.
    - a product that is not flagged `isCustom` has no pictures to carry (as before); a merge that
      transfers something flags the singular product `isCustom`.

    The batch import still does not read the legacy column: it adds to a dictionary and writes the
    column together with the English entry it sets, and never deletes a source row.
- **No `imageUrlEn` read under `src`.** The batch import's compare-and-set (`emoji-batch-import.ts`)
  reads and conditions on the dictionary: a queue write applies only while the main picture is empty
  and the dictionary is exactly as read (`localizedImages` equals the value read, or SQL NULL), so a
  picture, or any language, attached between the read and the write is never replaced or lost; a
  failed condition is re-read and reported as before. A historical cell writes by id unless it
  changes the dictionary of a record it read, in which case the same condition applies. An English
  entry is rewritten only when it changes. The exported-catalogue parser (`scripts/lib/catalog-export.ts`)
  and the Ya2 backfill (`scripts/lib/localized-pictures-backfill.ts`) are the readers of the legacy
  column left; both are tooling outside `src` with their own tests (`vitest` includes
  `scripts/lib`), and the parser reads `localizedImages.en` first, then `imageUrlEn` of an older
  export.
- **Deletion safety.** `isStoredImageInUse` (runtime) keeps a file that is the main picture or any
  dictionary entry (listed language or not) of any product, variant or history snapshot, or any
  category or library picture, and keeps the file when any of these checks fails. A variant and a
  history snapshot are references of their own: a file shown only there must not be deleted. Display and the
  rest of `src` do not read `imageUrlEn`, but a row can reference a file only there: the previous
  release writes the column alone, also between the Ya2 backfill and the switch of the code. So
  the guard carries one **transitional compatibility check**: `legacyEnglishReferenceExists`
  (`scripts/lib/legacy-picture-references.ts`), a boolean database count of products (other than the
  one being edited), variants and history snapshots whose legacy English column
  (`imageUrlEn`, `imageUrlEn`, `productImageUrlEn`) is the file. It returns no legacy value, an error makes the
  guard answer "in use", and it is tested for legacy-only denial and for fail-closed. The offline
  cleanup (`npm run db:files`) collects the same references (`collectReferencedFileKeys`: products,
  variants, history snapshots, categories, library) and passes the legacy columns to the shared
  collector through the same module; it stops when any read fails. **Ya6 removes all of it with the column** (the helper, its call
  in `isStoredImageInUse`, the cleanup's reader, and the transition helper with its two call sites:
  the list completion and the catalogue cleanup). Rollout order (run the Ya2 backfill, switch the
  code, run the backfill again, then any file cleanup) narrows the window but does not by itself
  make deletion safe: the check does, for as long as the column exists. The check and the delete
  are still not atomic (AGE-1472).
- **Rollback.** Writes keep mirroring the English entry into `imageUrlEn` (products, variants,
  history rows, the importer, catalogue cleanup), so the previous release shows the same pictures
  until Ya6.
- **Not done here.** Marking `imageTextLocale` from an import, importing a library cell into every
  product of its group, and the gap report belong to Ya4 and Ya5; the picture reserve for offline
  mode belongs to the offline plan.

## Not localized yet

- `manifest.json` and `offline.html` are static English files.
- Names of the default lists created for a new user are created in the user's language at that
  moment and are not translated later (they are user data afterwards).
