# Architecture Overview

Clickmoji Shop is a Next.js App Router application with API routes hosted in the same runtime. The focus is a fast mobile-first shopping list experience with emoji-first product selection and AI-assisted product management.

## Stack (current)

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS 4
- State/data: TanStack Query for server-backed data, Zustand only for transient UI selection state
- Backend: Next.js Route Handlers (`src/app/api`), Prisma ORM, PostgreSQL
- Auth: NextAuth v4 (Credentials + Google OAuth, JWT sessions)
- AI: `@google/genai` (Gemini/Imagen), OpenAI SDK (GPT Image)
- Uploads: UploadThing
- Search: PostgreSQL full-text + `pg_trgm` similarity in `/api/search`
- Testing: Vitest, Playwright
- Tooling: ESLint 9, Prettier, Husky + lint-staged

## Key decisions

- App Router and Route Handlers for full-stack cohesion.
- Prisma models optimized for list-centric workflows; items allow duplicates when notes differ.
- PostgreSQL enforces one active list per user with a raw SQL partial unique index.
- React Query owns server-backed lists, products, favorites, and list items; Zustand stores only the
  currently selected list id from navigation context.
- AI is optional and can be toggled per provider via `AI_PROVIDER`.
- Admin tooling is built into `/admin` and enforced by role checks.
- Auth hardening includes email normalization, password policy, and rate limiting helpers in `src/lib/auth-security.ts`.
- AI automation is routed through service modules under `src/lib/services`; endpoints handle auth,
  validation, rate limits, service calls, and response shaping.
- CI runs `npm run check`, `npm run build`, and a no-database Playwright smoke gate tagged
  `@smoke`.
- Public responses include baseline anti-framing, MIME-sniffing, referrer, and browser-permission
  security headers from `next.config.ts`.
- Public PWA and discovery assets bypass the application authentication boundary.

## Localization boundary

The visible UI is currently Russian-first. The target localization contract supports English and
Russian with English as the default. The migration is intentionally tracked as a coherent slice so
routes, metadata, validation, email, PWA content, and catalog fields do not drift into mixed-language
states. See `docs/localization.md`.

## Known gaps

- Persistent AI image caching is not implemented yet; AI responses expose stable cache keys and
  prompt versions so this can be added without changing route contracts.
- PWA offline support is baseline-only: static shell/offline page exists, but no offline API write queue.

## Related docs

- `docs/data-model.md`
- `docs/api.md`
- `docs/roadmap.md`
