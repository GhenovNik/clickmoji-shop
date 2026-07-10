# Clickmoji Shop

[![CI](https://github.com/GhenovNik/clickmoji-shop/actions/workflows/ci.yml/badge.svg)](https://github.com/GhenovNik/clickmoji-shop/actions/workflows/ci.yml)

Clickmoji Shop is a mobile-first shopping list application built around visual, emoji-based
product selection. It combines public catalog browsing with personal lists, favorites, shopping
history, product variants, and optional AI-assisted catalog tools.

[Open the live application](https://clickmoji-shop.vercel.app)

> The current application UI is Russian-first. The localization target is English by default with
> Russian as the second supported language. Source code comments and public engineering
> documentation are maintained in English. See [Localization](docs/localization.md).

## Product highlights

- Public category and product browsing without an account
- Credentials authentication with email verification and password reset
- Optional Google OAuth sign-in
- Multiple shopping lists with notes, variants, and purchased-item tracking
- Favorites ranked by usage and persisted shopping history
- Administrator tools for users, categories, products, and bulk catalog operations
- Optional Gemini and GPT Image integrations for product analysis and custom emoji assets
- UploadThing-backed administrator image uploads
- Basic PWA shell with a manifest, service worker, and offline fallback

## Screenshots

<p align="center">
  <img src="docs/assets/clickmoji-home.png" alt="Clickmoji Shop home screen" width="68%" />
  <img src="docs/assets/clickmoji-catalog-mobile.png" alt="Clickmoji Shop mobile catalog" width="27%" />
</p>

These screenshots are generated from the local production build with synthetic catalog data. They
do not contain production accounts or shopping-list content.

## Technology

- Next.js App Router, React, and TypeScript
- Tailwind CSS
- Prisma ORM and PostgreSQL
- NextAuth with JWT sessions
- TanStack Query for server state and Zustand for transient selection state
- UploadThing, Google GenAI, and OpenAI as optional integrations
- Vitest and Playwright

The browser application and API route handlers run in the same Next.js deployment. PostgreSQL is
the source of truth; React Query owns server-backed client state. See the full
[architecture overview](docs/architecture.md).

## Requirements

- Node.js 24
- npm 10 or newer
- PostgreSQL 14 or newer

Optional features require provider accounts for Google OAuth, Resend, Upstash Redis, UploadThing,
Google GenAI, or OpenAI.

## Local setup

```bash
git clone https://github.com/GhenovNik/clickmoji-shop.git
cd clickmoji-shop
npm ci
cp .env.example .env
npx prisma migrate dev
npx prisma db seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The minimum local configuration is:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/clickmoji_shop?schema=public"
AUTH_URL="http://localhost:3000"
AUTH_SECRET="replace-with-a-random-secret"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

Generate a development auth secret with `openssl rand -base64 32`. Keep all real credentials out
of Git. The complete, annotated configuration is in [.env.example](.env.example).

## Optional integrations

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: Google OAuth
- `RESEND_API_KEY` and `RESEND_FROM_EMAIL`: verification and reset email delivery
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: distributed rate limiting
- `UPLOADTHING_TOKEN`: administrator-managed product and category images
- `GOOGLE_GENAI_API_KEY`: Gemini and Imagen features
- `OPENAI_API_KEY` with `AI_PROVIDER="gpt-image"`: GPT Image generation

Without the optional providers, the catalog and core list workflows remain available. Production
deployments should configure Upstash so rate limits are shared across server instances.

## Commands

```bash
npm run dev                 # Start the development server
npm run format:check        # Check repository formatting
npm run check               # Generate Prisma client, typecheck, lint, and run unit tests
npm run build               # Create a production build
npm run test:coverage       # Run unit tests with coverage output
npm run test:e2e:smoke      # Run deterministic browser smoke tests without PostgreSQL
npm run test:e2e            # Run the full browser suite; requires a prepared database
npm run verify              # Formatting, static checks, unit tests, and production build
npm run verify:full         # Full verification plus deterministic browser smoke
npm run audit:prod          # Audit production dependencies at high severity or above
```

See [TESTING_GUIDE.md](TESTING_GUIDE.md) for the database-backed E2E prerequisites and the
Playwright authentication-bypass safety contract.

## Project structure

```text
src/app/          Pages, layouts, and API route handlers
src/components/   Product, list, layout, and administration UI
src/hooks/        React Query and client workflow hooks
src/lib/          Auth, Prisma, services, validation, and shared utilities
prisma/           Schema, migrations, and seed data
tests/e2e/        Playwright browser flows
docs/             Architecture, API, operations, UX, and roadmap documentation
scripts/          Explicit database and storage administration tools
```

## Security model

- User-owned APIs validate the active session and resource ownership.
- Administrator APIs enforce the `ADMIN` role on the server.
- Authentication and AI endpoints are rate-limited; production should use distributed storage.
- Verification and password-reset tokens are random, hashed at rest, expiring, and single-use.
- UploadThing product/category uploads are administrator-only.
- The Playwright auth bypass is disabled unless explicit test-only environment flags and a matching
  cookie are present.

Dependency advisories are reviewed by reachability and compatibility. The project does not use
`npm audit fix --force` because its suggested downgrades can replace supported framework versions.

## Documentation

- [Architecture](docs/architecture.md)
- [API](docs/api.md)
- [Data model](docs/data-model.md)
- [AI features](docs/ai.md)
- [UX flows](docs/ux-flows.md)
- [Operations](docs/ops.md)
- [Localization](docs/localization.md)
- [Roadmap](docs/roadmap.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch model and required verification commands.

## License

No open-source license has been selected yet. The repository is publicly visible, but that does not
grant permission to reuse or redistribute the source. A license decision is tracked as a release
follow-up.
