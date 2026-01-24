# Architecture Overview

Clickmoji Shop is a Next.js App Router application with API routes hosted in the same runtime. The focus is a fast mobile-first shopping list experience with emoji-first product selection and AI-assisted product management.

## Stack (current)

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS
- State/data: Zustand, TanStack Query
- Backend: Next.js Route Handlers (`src/app/api`), Prisma ORM, PostgreSQL
- Auth: NextAuth (credentials provider, JWT sessions)
- AI: `@google/genai` (Gemini/Imagen), OpenAI SDK (GPT Image)
- Uploads: UploadThing
- Search: PostgreSQL full-text + `pg_trgm` similarity in `/api/search`
- Testing: Vitest, Playwright
- Tooling: ESLint, Prettier, Husky + lint-staged

## Key decisions

- App Router and Route Handlers for full-stack cohesion.
- Prisma models optimized for list-centric workflows; items allow duplicates when notes differ.
- AI is optional and can be toggled per provider via `AI_PROVIDER`.
- Admin tooling is built into `/admin` and enforced by role checks.

## Known gaps

- OAuth providers are not integrated yet.
- PWA/offline support is planned but not implemented.
- Product variants exist in the schema but are not exposed in UI.

## Related docs

- `docs/data-model.md`
- `docs/api.md`
- `docs/roadmap.md`
