# Ops and Environment

## Environment variables

```env
DATABASE_URL="postgresql://user:password@localhost:5432/clickmoji_shop"
NEXTAUTH_SECRET="your-secret-key"
NEXTAUTH_URL="http://localhost:3000"
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
RESEND_API_KEY="your-resend-api-key"
RESEND_FROM_EMAIL="no-reply@clickmoji.shop"
UPLOADTHING_TOKEN="your-uploadthing-token"
GOOGLE_GENAI_API_KEY="your-google-api-key"
OPENAI_API_KEY="your-openai-api-key"
AI_PROVIDER="gemini"
```

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

## Security notes

- Passwords are hashed with bcrypt
- Admin access enforced by role checks
- API role checks centralized in `src/lib/auth-guards.ts` (use `requireAdmin`/`requireUser`)
- Keep secrets out of `NEXT_PUBLIC_*`
