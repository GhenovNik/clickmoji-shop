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
- Categories, products, emoji grid browsing
- Search and autocomplete
- Favorites with usage tracking
- Multiple lists, notes, purchase toggles, import from text
- Admin UI for categories/products/users
- AI emoji generation, bulk import, smart create
- UploadThing integration

## Next

### Auth improvements (priority order)

1. Stronger validation and password rules
2. Password reset flow
3. Email verification
4. OAuth (Google)
5. RBAC checks for admin APIs

### Product model evolution

- Product variants UI and API
- Optional uniqueness rules for base items

### Experience

- PWA offline support
- Stabilize history persistence

## Post-MVP

- Real-time collaboration
- Sharing lists between users
- Push notifications
- Barcode scanning
- Pricing/budget tracking
- Recipes and ingredient import

## Open questions

- Where should history be persisted: DB or client-side cache?
- Do we need a separate table for shared lists or per-user access rules?
