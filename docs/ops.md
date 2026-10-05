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
AI_PROVIDER="gemini" # or "gpt-image"; anything else falls back to the gemini branch
GOOGLE_GENAI_API_KEY="your-google-api-key"
OPENAI_API_KEY="your-openai-api-key"

# Optional image model overrides. Leave them unset to use the defaults (see docs/ai.md).
# Uncomment a line only to switch the model on purpose; copied as they are, they keep the defaults:
# GOOGLE_IMAGE_MODEL="gemini-3.1-flash-lite-image"   # models.generateContent
# OPENAI_IMAGE_MODEL="gpt-image-2.5-flare"           # images.generate, background transparent

# Deprecated synonym of GOOGLE_IMAGE_MODEL; read only when that variable is unset/empty/whitespace.
# IMAGEN_MODEL="gemini-3.1-flash-image"
```

### Image model switch (Vercel)

`GOOGLE_IMAGE_MODEL` and `OPENAI_IMAGE_MODEL` are optional. While both are absent (or empty or
whitespace) production uses the defaults chosen on 2026-10-04: Google
`gemini-3.1-flash-lite-image` through `models.generateContent`, OpenAI `gpt-image-2.5-flare`
through `images.generate` with `size 1024x1024`, `quality medium` and `background transparent`.

- Before any change, write down the current values and whether each of `AI_PROVIDER`,
  `GOOGLE_IMAGE_MODEL`, `IMAGEN_MODEL` and `OPENAI_IMAGE_MODEL` is present (no secrets).
- Switch: set the variable in the Vercel project environment (Production and/or Preview) and redeploy.
  No code release is needed. Only the variables of the active provider are read.
- Model EOL to plan against: `imagen-4.0-*` was retired by Google on 2026-08-17, `gpt-image-1.5` is
  retired by OpenAI on 2026-12-01. The two current defaults have no announced shutdown date.
- Verify the value against the grammar before saving, otherwise generation fails with a configuration
  error naming the variable: `^imagen-[a-z0-9]+(?:[.-][a-z0-9]+)*$` for the Imagen adapter,
  `^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*-image(-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$` for the Gemini adapter,
  `^gpt-image-[a-z0-9]+(?:[.-][a-z0-9]+)*$` for the OpenAI branch.
- Three separate actions, do not mix them up:
  - **roll back the configuration**: restore exactly the values written down above and redeploy;
  - **return to the default**: delete the override variable and redeploy (this is not a rollback);
  - **roll back the code**: revert the squash commit and redeploy — that restores the retired
    `imagen-4.0-generate-001` default, so it does not promise a working generation path.
- Check the server log after the first manual generation: adapter error classes (`blocked-prompt`,
  `blocked`, `incomplete`, `no-image`, `unsupported-format`, `empty-image`, `invalid-png`, `too-large`)
  are visible in the server log and never in the HTTP response.
- Google has no transparent background, so emoji from the Google branch carry a white field; see the
  known limitations and the provider comparison in `docs/ai.md`.

### Env strategy (Vercel)

- Production (`master`):
  - Pooled `DATABASE_URL` for the production DB with `sslmode=verify-full`
  - `NEXTAUTH_SECRET` (strong secret). _Note: `NEXTAUTH_URL` is handled automatically by Vercel._
  - OAuth/email keys (`GOOGLE_*`, `RESEND_*`) as needed
  - `UPSTASH_REDIS_*` (recommended)
- Preview (`develop` and feature branches):
  - Separate preview DB (`DATABASE_URL`)
  - Never reuse the production database URL; leave database-backed preview routes disabled until a
    dedicated database or Neon branch is available
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
- Before a production migration, create and verify a fresh backup, run `prisma migrate deploy` with
  a direct/unpooled database URL, and confirm `prisma migrate status` afterwards.

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
- Runtime baseline: Node.js 24 in Vercel, `.nvmrc`, package engines, and CI
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
