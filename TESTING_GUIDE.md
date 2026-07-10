# Testing Guide

This project uses TypeScript, ESLint, Prettier, Vitest, and Playwright. The default quality gates
are designed to run without access to production services.

## Quick reference

```bash
npm run format:check       # Repository formatting
npm run check              # Prisma generation, typecheck, lint, and unit tests
npm run build              # Production build
npm run test:coverage      # Unit tests with text, JSON, and HTML coverage
npm run test:e2e:smoke     # Deterministic browser smoke without PostgreSQL
npm run test:e2e           # Full browser suite with a prepared database
npm run verify             # Formatting, check, and build
npm run verify:full        # Full verification plus deterministic browser smoke
```

## Unit and contract tests

Vitest discovers `src/**/*.{test,spec}.{ts,tsx}`. Tests run in JSDOM and load shared setup from
`src/test/setup.ts`.

```bash
npm run test
npm run test:watch
npm run test:ui
npm run test:coverage
```

Contract tests protect a small number of cross-file invariants such as documentation/auth labels,
the active-list database constraint, the Playwright-only auth bypass, client-state ownership, and
the UploadThing dependency override. They complement behavior tests; they are not a replacement for
API or browser coverage.

## Deterministic browser smoke

The `@smoke` Playwright tests mock session, catalog, list, and add-item API responses. They verify
public catalog access and core authenticated list interactions without requiring PostgreSQL.

```bash
npx playwright install --with-deps chromium
npm run test:e2e:smoke
```

When bundled Chromium is unavailable locally, use an installed Chrome binary:

```bash
PLAYWRIGHT_CHROMIUM_CHANNEL=chrome npm run test:e2e:smoke
```

### Test-only authentication bypass

The Playwright web server sets `PLAYWRIGHT_AUTH_BYPASS=1` and a dedicated token. Protected-page
access is bypassed only when both the environment flag and the matching `clickmoji-e2e-auth` cookie
are present.

Rules:

- Never configure `PLAYWRIGHT_AUTH_BYPASS` in preview or production environments.
- Never reuse the bypass token as an application secret.
- Keep the bypass gated in `src/proxy.ts` and covered by contract tests.
- Browser fixtures belong in `tests/e2e/fixtures` and must contain synthetic data only.

## Database-backed browser tests

The full suite includes authentication and API flows that require a disposable PostgreSQL database.
Do not run it against production.

```bash
cp .env.example .env.test.local
# Configure DATABASE_URL for a disposable database.
npx prisma migrate deploy
npx prisma db seed
npm run test:e2e
```

Use a dedicated OAuth/email configuration or leave those optional integrations disabled. Test data
must not depend on production users or provider credentials.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `develop` and `master`:

1. `npm ci`
2. typecheck
3. lint
4. unit tests
5. production build
6. Chromium installation
7. deterministic E2E smoke

The `CI / validate` job is the required branch-protection check.

## Expected baseline

- TypeScript: zero errors
- ESLint: zero errors; warnings should be resolved or explicitly justified
- Unit/contract tests: all passing
- Deterministic E2E smoke: all passing
- Production audit: zero high or critical advisories
- Full dependency audit: zero high or critical advisories

Run `npm run verify:full` before a release candidate is pushed.
