# Ops and Environment

## Environment variables

```env
DATABASE_URL="postgresql://user:password@localhost:5432/clickmoji_shop"
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# NextAuth v4
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-secret-key"

# Google OAuth
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"

# Email Delivery
RESEND_API_KEY="your-resend-api-key"
RESEND_FROM_EMAIL="no-reply@clickmoji.shop"

# Rate Limiting (Redis)
UPSTASH_REDIS_REST_URL="https://<name>.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-upstash-rest-token"

# File Uploads
UPLOADTHING_TOKEN="your-uploadthing-token"

# AI Integration
AI_PROVIDER="gemini" # or "gpt-image"
GOOGLE_GENAI_API_KEY="your-google-api-key"
OPENAI_API_KEY="your-openai-api-key"
```

### Env strategy (Vercel)

- Production (`master`):
  - Real `DATABASE_URL` (production DB)
  - `NEXTAUTH_SECRET` (strong secret). _Note: `NEXTAUTH_URL` is handled automatically by Vercel._
  - OAuth/email keys (`GOOGLE_*`, `RESEND_*`) as needed
  - `UPSTASH_REDIS_*` (recommended)
- Preview (`develop` and feature branches):
  - Separate preview DB (`DATABASE_URL`)
  - Separate OAuth app is recommended for preview
  - `UPSTASH_REDIS_*` can be shared or separate
- Development (local `.env`):
  - Local DB URL
  - Local auth secrets
  - Optional external providers

## Database

- Create and apply local migrations: `npx prisma migrate dev`
- Deploy migrations (prod): `npx prisma migrate deploy`
- Seed data: `npx prisma db seed`
- Backup DB (to `backups/*.dump`): `npm run db:backup`
- Restore DB (latest backup): `npm run db:restore`
- Restore DB (specific file): `npm run db:restore -- clickmoji-YYYYMMDD-HHMMSS.dump`
- Production backups must be encrypted, access-controlled, monitored, and restore-tested.
- Do not use ordinary GitHub Actions artifacts as the long-term production backup store.

## Scripts

- `npm run dev` (Start local server)
- `npm run check` (Typecheck + Lint + Test)
- `npm run lint`
- `npm run test` (Vitest single run)
- `npm run test:watch` (Vitest watch mode)
- `npm run test:e2e` (Playwright)

## PWA

- Service worker: `public/sw.js`
- Manifest: `public/manifest.json`
- Offline fallback: `public/offline.html`

### DB Scripts (domain)

Execute using `tsx`:

- Users: `npx tsx scripts/db-users.ts --help`
- Products: `npx tsx scripts/db-products.ts --help`
- Categories: `npx tsx scripts/db-categories.ts --help`
- Lists: `npx tsx scripts/db-lists.ts --help`
- Files: `npx tsx scripts/db-files.ts --help`
- Transfer: `npx tsx scripts/db-transfer.ts --help`

## Deploy

- Default target: Vercel
- Ensure all environment variables are set per environment
- Run `prisma migrate deploy` before deploying application code that depends on a migration.
- Seed only new, empty environments; do not seed production automatically.

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
- `NEXT_PUBLIC_APP_URL` is intentionally public and must contain only the canonical site URL.
- Production rate limiting should use Upstash rather than the per-process memory fallback.
