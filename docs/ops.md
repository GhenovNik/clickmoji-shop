# Ops and Environment

## Environment variables

```env
DATABASE_URL="postgresql://user:password@localhost:5432/clickmoji_shop"
NEXTAUTH_SECRET="your-secret-key"
NEXTAUTH_URL="http://localhost:3000"
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

## Deploy

- Default target: Vercel
- Ensure all environment variables are set per environment
- Run `prisma migrate deploy` and `prisma db seed` on first deploy

## Security notes

- Passwords are hashed with bcrypt
- Admin access enforced by role checks
- Keep secrets out of `NEXT_PUBLIC_*`
