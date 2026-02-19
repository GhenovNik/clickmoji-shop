# Ops and Environment

## Environment variables

```env
DATABASE_URL="postgresql://user:password@localhost:5432/clickmoji_shop"
AUTH_SECRET="your-secret-key"
AUTH_URL="http://localhost:3000"
AUTH_REQUIRE_EMAIL_VERIFICATION=""
# optional aliases for compatibility
NEXTAUTH_SECRET="your-secret-key"
NEXTAUTH_URL="http://localhost:3000"
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
RESEND_API_KEY="your-resend-api-key"
RESEND_FROM_EMAIL="no-reply@clickmoji.shop"
UPSTASH_REDIS_REST_URL="https://<name>.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-upstash-rest-token"
UPLOADTHING_TOKEN="your-uploadthing-token"
GOOGLE_GENAI_API_KEY="your-google-api-key"
OPENAI_API_KEY="your-openai-api-key"
AI_PROVIDER="gemini"
```

### Env strategy (Vercel)

- Production (`master`):
  - Real `DATABASE_URL` (production DB)
  - `NEXTAUTH_URL=https://clickmoji-shop.vercel.app`
  - `NEXTAUTH_SECRET` (strong secret)
  - OAuth/email keys (`GOOGLE_*`, `RESEND_*`) as needed
  - `UPSTASH_REDIS_*` (recommended)
- Preview (`develop` and feature branches):
  - Separate preview DB (`DATABASE_URL`)
  - `NEXTAUTH_URL` should be set to deployed preview URL when testing OAuth callbacks
  - Separate OAuth app is recommended for preview
  - `UPSTASH_REDIS_*` can be shared or separate
- Development (local `.env`):
  - Local DB URL
  - Local auth secrets
  - Optional external providers

## Database

- Migrations: `npx prisma migrate dev`
- Seed data: `npx prisma db seed`

## Scripts

- `npm run typecheck`
- `npm run lint`
- `npm run test` (Vitest)
- `npm run test:e2e` (Playwright)

## PWA

- Service worker: `public/sw.js`
- Manifest: `public/manifest.json`
- Offline fallback: `public/offline.html`

### DB Scripts (domain)

- Users: `npx tsx scripts/db-users.ts --help`
- Products: `npx tsx scripts/db-products.ts --help`
- Categories: `npx tsx scripts/db-categories.ts --help`
- Lists: `npx tsx scripts/db-lists.ts --help`
- Files: `npx tsx scripts/db-files.ts --help`
- Transfer: `npx tsx scripts/db-transfer.ts --help`

## Deploy

- Default target: Vercel
- Ensure all environment variables are set per environment
- Run `prisma migrate deploy` and `prisma db seed` on first deploy

## Branching and release flow

- `master`: production-only branch (stable)
- `develop`: integration branch (auto-preview)
- `feature/*`: short-lived task branches from `develop`
- Open PRs into `develop`, test in Vercel Preview, then merge `develop` -> `master` for production release

## Security notes

- Passwords are hashed with bcrypt
- Admin access enforced by role checks
- API role checks centralized in `src/lib/auth-guards.ts` (use `requireAdmin`/`requireUser`)
- Keep secrets out of `NEXT_PUBLIC_*`
