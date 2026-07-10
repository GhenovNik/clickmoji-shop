# Roadmap

This roadmap reflects the current codebase and highlights what is planned next.

## Definition of Done

- `npm run check` passes (includes typecheck, lint, and unit tests)
- Critical user flows covered by tests or manual checklist
- Loading/error/empty states for core screens
- Security checks for auth and admin APIs

## Done

- Credentials auth (NextAuth + JWT) and registration flow
- Password validation and auth rate limiting (IP/email)
- Password reset flow (request + confirm token)
- Email verification flow (verify + resend)
- OAuth (Google) support
- RBAC guards for admin and signed-in APIs
- Categories, products, emoji grid browsing
- Search and autocomplete
- Favorites with usage tracking
- Multiple lists, notes, purchase toggles, import from text
- History persistence in DB with restore/delete flows
- Admin UI for categories/products/users
- AI emoji generation, bulk import, smart create
- AI service hardening: dedicated service modules, rate limits, prompt versions, and cache-key metadata
- Product variants in API and UI (admin + selection)
- UploadThing integration
- PWA baseline (manifest, service worker registration, offline fallback page)
- Security, public-catalog, active-list, client-state, AI-service, image-performance,
  documentation, and deterministic E2E remediation program
- UploadThing v7 retained with a compatible transitive security override

## Next

### Audit remediation follow-through

- Convert remaining admin-only raw image previews to `next/image` or explicitly suppress the lint
  warning with rationale.

### Security and operations

- Move production database backups from GitHub Actions artifacts to encrypted, access-controlled
  storage and add restore verification
- Add a tested Content Security Policy after the locale and third-party asset boundaries stabilize
- Enable private vulnerability reporting and choose the repository license

### Product model evolution

- Optional uniqueness rules for base items when variants are absent

### Experience

- Add English-first localization with complete English and Russian catalogs
- Expand offline capabilities beyond static shell (API/data strategy, retry queue)
- Add installability and update UX for PWA
- Tighten loading/error/empty states on edge flows
- Replace remaining `alert`/`confirm` flows with app-level toasts/dialogs

## Post-MVP

- Real-time collaboration
- Sharing lists between users
- Push notifications
- Barcode scanning
- Pricing/budget tracking
- Recipes and ingredient import

## Open questions

- Do we need a separate table for shared lists or per-user access rules?
- Which AI provider should be default in production and what fallback policy is acceptable?
