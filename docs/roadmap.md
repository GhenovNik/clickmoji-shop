# Roadmap

This roadmap reflects the current codebase and highlights what is planned next.

## Definition of Done

- `npm run typecheck` passes
- `npm run lint` passes
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
- Product variants in API and UI (admin + selection)
- UploadThing integration
- PWA baseline (manifest, service worker registration, offline fallback page)

## Next

### AI hardening (priority order)

1. Rate limiting for AI endpoints (`/api/emoji/*`, `/api/products/*`, `/api/lists/import-text`)
2. Caching by normalized product name + prompt version
3. Prompt versioning for reproducibility and safer rollbacks

### Product model evolution

- Optional uniqueness rules for base items when variants are absent
- Database-level guarantee for one active list per user (partial unique index)

### Experience

- Expand offline capabilities beyond static shell (API/data strategy, retry queue)
- Add installability and update UX for PWA
- Tighten loading/error/empty states on edge flows

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
