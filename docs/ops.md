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

# Optional text model override for product automation. Unset/empty/whitespace = gemini-3.8-flash.
# Must be one of the exact text-generation IDs in docs/ai.md#text-model-selection.
# GOOGLE_TEXT_MODEL="gemini-3.8-flash"

# Optional image model overrides. Leave them unset to use the defaults (see docs/ai.md).
# Uncomment a line only to switch the model on purpose; copied as they are, they keep the defaults:
# GOOGLE_IMAGE_MODEL="gemini-3.1-flash-image"        # models.generateContent (sole verified bounded Google model)
# OPENAI_IMAGE_MODEL="gpt-image-2.5-flare"           # images.generate, background transparent

# Deprecated synonym of GOOGLE_IMAGE_MODEL; read only when that variable is unset/empty/whitespace.
# IMAGEN_MODEL="gemini-3.1-flash-image"

# Shared monthly monetary cap across all users and instances (UTC month, USD).
# Unset/empty/whitespace = $10.00 default. "0" or malformed = fail closed (503, AI only).
# AI_MONTHLY_BUDGET_USD="10"
```

### Text AI overload and quota accounting (AGE-1540)

The three text routes (list import, smart-create, admin bulk import) allow 60 seconds of route
execution (`maxDuration = 60`). The text service has a total 30-second budget across retries and
fallback; retries do not acquire more daily units. Exhausted temporary provider availability
returns HTTP 503 with `Retry-After: 60` and a localized overload message. The import modal displays
it inline, preserves the entered list and lets the shopper retry; it never opens a native alert.
Hourly abuse throttles are unchanged and still count requests, including failed ones.

Every runtime text entry point, including `scripts/db-products.ts import`, uses the shared text
policy: at most three attempts, an 8-second hard timeout per attempt, exponential equal jitter
of [500, 1000) then [1000, 2000) milliseconds. Only 503/429, canonical `UNAVAILABLE`/
`RESOURCE_EXHAUSTED` and network timeouts retry; other 4xx never retry. Optional
`GOOGLE_TEXT_MODEL_FALLBACK` selects the third attempt's model; unset/blank keeps the primary.
Both model settings are validated before any SDK request. Each attempt logs only code and number.
Primary and fallback share an exact allowlist (`SUPPORTED_GOOGLE_TEXT_MODELS`); a `gemini-*` name
alone proves no capability. Embedding, image, TTS, live/audio and unknown IDs are refused before
SDK construction. Configuration diagnostics name the env and `UNSUPPORTED_TEXT_MODEL`, not its raw
value or keys. See `docs/ai.md#text-model-selection` for supported IDs, sources and update policy.
The operator CLI has no authenticated shopper and therefore no per-user daily reservation, but
`scripts/db-products.ts import` reserves and reconciles against the shared `ai_monthly_budgets`
monthly monetary cap via `runMonthlyBudgetedTextAiCall`; its existing product writes are not run
by the regression tests.

Daily text accounting is **one unit per successful logical text operation**, including internal
retries, fallback and AI response parsing, not one unit per provider attempt. The shared PostgreSQL
budget is reserved immediately before the operation; failed generation or AI parsing compensates
one unit before the route returns an error. A successful AI result remains charged even if product
persistence, category matching or later list writes fail. Image reservations (including smart-create's
optional image) keep their previous attempt-based behavior and are not compensated here.

Reservation failure denies the operation without contacting the provider. Compensation is one atomic
conditional UPDATE of the original user's original UTC-day counter (`count > 0`), not a read/modify/
write and not a transaction held across provider network I/O. The timestamp is captured before
reservation, so an operation crossing midnight cannot debit/refund the next day by mistake.
The helper has one private failure catch and exposes no reusable refund handle.

**Conservative failure mode:** process termination after reservation, or a database outage during
compensation, can retain a daily unit. Compensation failure logs an allowlisted code only and is
never blindly retried: an ambiguous commit must not be decremented twice. No automatic counter
reset/reconciliation or new migration is required. Do not replay compensation manually without
independent evidence of the original reservation and whether the UPDATE committed.

### Image model switch (Vercel)

`GOOGLE_IMAGE_MODEL` and `OPENAI_IMAGE_MODEL` are optional. While `AI_PROVIDER` is unset (or
anything other than `"gpt-image"`) production uses Google `gemini-3.1-flash-image` through
`models.generateContent` (`candidateCount: 1`, `maxOutputTokens: 32768`). Setting
`AI_PROVIDER="gpt-image"` (with any `OPENAI_IMAGE_MODEL`, such
as `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2`, or `gpt-image-1.5`) is rejected
fail-closed **before** reserving budget or calling OpenAI because OpenAI `images.generate` lacks a
documented fixed per-image price or enforceable output-token ceiling; `POST /api/emoji/generate`
returns `503` (`api.aiQuota.unavailable`) and `POST /api/products/smart-create` falls back to the
Unicode emoji while preserving bounded Gemini text analysis. Explicit unproven or retired Google
models (e.g. `gemini-3.1-flash-lite-image`, `imagen-4.0-*`) also fail closed before reservation or SDK dispatch.

- Before any change, write down the current values and whether each of `AI_PROVIDER`,
  `GOOGLE_IMAGE_MODEL`, `IMAGEN_MODEL` and `OPENAI_IMAGE_MODEL` is present (no secrets).
- Switch: set the variable in the Vercel project environment (Production and/or Preview) and redeploy.
  No code release is needed. Only the variables of the active provider are read.
- Model EOL to plan against: `imagen-4.0-*` was retired by Google on 2026-08-17, `gpt-image-1.5` is
  retired by OpenAI on 2026-12-01. `gemini-3.1-flash-image` has no announced shutdown date.
- Verify the value against the proven allowlist (`SUPPORTED_GOOGLE_IMAGE_MODELS` in
  `src/lib/ai-pricing.ts`, currently `gemini-3.1-flash-image`) before saving, otherwise generation
  fails with a configuration error naming the variable before budget reservation or SDK dispatch.
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
- Both run `pg_dump` / `pg_restore` in the `postgres:17-alpine` image: production is PostgreSQL 17.11
  and a `pg_dump` 16 client refuses a 17 server.
- Production backups must be encrypted, access-controlled, monitored, and restore-tested.
- Do not use ordinary GitHub Actions artifacts as the long-term production backup store.
- Before a production migration, create and verify a fresh backup, run `prisma migrate deploy` with
  a direct/unpooled database URL, and confirm `prisma migrate status` afterwards.

### Production recovery

Never restore into the live database. Identify the incident time and last known good data; keep
writes stopped during the final switch so new writes are not lost. Restore to a separate target,
verify it, then change the site's production `DATABASE_URL` in Vercel and redeploy. Keep the old
target until the operator approves its retirement. A failed check blocks the switch.

Production copies belong on the Mac mini and replicated Lenovo storage, not GitHub artifacts.
The scheduled encrypted backup implementation is pending; do not treat the local `db:backup` and
`db:restore` scripts above as the production recovery procedure. Select a verified encrypted
custom-format dump and its verification record, including table counts and latest migration.

1. **Recent incident:** In the Neon console select the production project and source branch,
   create a new branch using point-in-time restore at a timestamp before the incident (within
   the available restore window). Select its database and obtain its direct connection URL.
   The branch contains the historical source data. Proceed to verification below.
2. **Older incident:** Select the verified encrypted copy for the desired date. Create a new Neon
   branch and a new database within it. A Neon branch inherits its parent's data: a new branch
   alone is not empty. Use the newly created empty database, never the inherited database, and
   obtain its direct URL. Verify it is empty before running the restore below.
3. **Neon unavailable:** Provision a separate PostgreSQL 17 instance and fresh empty database at
   another provider, with TLS and a direct URL. Verify emptiness and restore the selected copy.

#### Container and key preparation

Use Docker on a trusted operator machine. Substitute the reviewed `postgres:17-alpine` image
digest from the backup implementation once available; the placeholder deliberately fails until
then. The image installs `age` inside the disposable container. No host age installation is needed.
To create a new age identity for future backups, run the following in a private terminal. The
private key appears on screen: record it directly in the password manager and on paper, and give
only the public recipient to the backup configuration. Do not redirect output, record the terminal,
share the private key or use a newly generated key to decrypt an existing backup.

```sh
docker run --rm -it postgres:17-alpine@sha256:<REVIEWED_DIGEST> sh -c 'apk add --no-cache age >/dev/null && age-keygen'
```

#### Restore the encrypted copy

Set the placeholders locally in a private terminal. Use an absolute path to the selected `.age`
file. The URL must identify the new empty database, never the production database. Avoid shell
tracing, session recording and shared terminals. The URL is passed in the container environment
and is visible to privileged Docker administrators while it runs.

```sh
IMAGE='postgres:17-alpine@sha256:<REVIEWED_DIGEST>'
BACKUP_DIR='<absolute-directory-containing-encrypted-copy>'
BACKUP_FILE='<selected-copy>.dump.age'
read -rs 'TARGET_URL?Direct URL of NEW empty database: '; echo
export TARGET_URL BACKUP_FILE
docker run --rm -i -e TARGET_URL "$IMAGE" sh -c   'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -c "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');"'
```

Stop if any application tables appear, or if the connection fails; independently confirm the
provider, project, branch and database are the intended new target. Then paste the existing
single-line `AGE-SECRET-KEY-...` identity when prompted; it is not echoed or saved as a key file.
The encrypted file is mounted read-only. The pipeline runs inside the container with `pipefail`
and `pg_restore --exit-on-error`, so either decryption or restore failure stops the procedure.
A partial restore must be discarded and retried in another fresh empty database.

```sh
read -rs 'AGE_IDENTITY?Age private identity: '; echo
printf '%s\n' "$AGE_IDENTITY" | docker run --rm -i -e TARGET_URL \
  -v "$BACKUP_DIR:/backup:ro" -e BACKUP_FILE "$IMAGE" sh -c '
    set -eu
    set -o pipefail
    apk add --no-cache age >/dev/null
    age -d -i /dev/stdin "/backup/$BACKUP_FILE" | pg_restore --no-owner --no-privileges --exit-on-error --dbname "$TARGET_URL"
  '
RESTORE_STATUS=$?
unset AGE_IDENTITY
printf 'Restore exit: %s\n' "$RESTORE_STATUS"
```

Proceed only on exit 0. No plaintext dump is written by this procedure; protect terminal and Docker
access, and do not paste secrets into logs or tickets. `unset` does not erase shell memory; close the
terminal after the operation. Clean up any plaintext or temporary files created outside this procedure.

#### Verification and switch

Use the direct target URL for the following read-only checks. Generic checks also work with a
synthetic custom-format dump: compare its expected tables and row counts to the restored data.

```sh
docker run --rm -i -e TARGET_URL "$IMAGE" sh -c 'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database(), version();" -c "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1,2;"'
```

For Clickmoji, compare table names and counts with the selected backup's verification record;
inspect representative users, lists and products without exposing personal data. Check the latest
successful `_prisma_migrations` entry against that record and the intended release. From the checked
out release with dependencies installed, run `DATABASE_URL="$TARGET_URL" npx prisma migrate status`.
This repository's `prisma.config.ts` reads `DATABASE_URL` and migrations from `prisma/migrations`;
ensure it points to the target, since an unset value falls back to localhost. Investigate any mismatch
or nonzero status before switching; do not blindly deploy migrations or seed restored data. Check the
application against the target in an isolated preview, including sign-in and reading a test list.

For a real incident only, after all checks pass, set production `DATABASE_URL` in Vercel to the
verified target's appropriate pooled URL with TLS and redeploy. Verify the deployed site and logs;
record the selected backup/time, target, checks and switch time without credentials. If validation
fails, keep the original site setting and investigate. Unset `TARGET_URL`, remove temporary targets
and files when no longer needed, and retain the selected encrypted backup according to policy.

#### Recovery drill

Quarterly and before the first users, use the latest verified encrypted backup and the same restore
command above into a fresh empty disposable database. Verify the key, restore exit and generic and
Clickmoji-specific checks, record the outcome and clean up the disposable database. Never change site
settings during a drill. For a synthetic drill, encrypt a known custom-format test dump to the same
recipient, restore it with the identical command, and compare its expected tables and counts; the
Clickmoji migration and application checks apply only to an actual Clickmoji backup.

### Duplicate variant repair (AGE-1536 / AGE-1545)

Migration `20261102224241_drop_legacy_item_variant_unique` removes the legacy
`items_listId_productId_variantId_key` with `DROP INDEX IF EXISTS`. Existing shopping rows and
history are not deleted. Do not edit or mark the older migration as reapplied: an already recorded
migration does not repair a surviving index. The repair is safe when the index is already absent.

The ordinary (non-CONCURRENTLY) `DROP INDEX` requests **ACCESS EXCLUSIVE on `items`**: it can
block **SELECT/readers as well as writers** while held, and new requests can queue behind its
lock request. The migration sets `lock_timeout = '5s'` and `statement_timeout = '15s'` before DROP.
The first bounds each lock wait; the second bounds statement execution, not the entire deployment.
These are not a promise of zero interruption. Use a quiet window and stop on timeout.

Prisma execution was checked against the installed CLI 7.10.1 / schema engine
`d1b3f377ca835d73fd50954a5e22128b9ebdd6b8` on local PostgreSQL: a single-statement CONCURRENTLY
probe succeeds, and two writes in one migration file have different transaction IDs. This engine
executes statements without a file-wide transaction. We retain ordinary DROP, not CONCURRENTLY.
The timeout SETs belong only to the dedicated migration connection; RESET restores its default
policy on success (verified by a following migration). On failure the deploy command exits and
closes that connection. There is no global/server or application-pool timeout change. Explicit
BEGIN was not used: on this engine an aborted transaction masks the original lock error while
Prisma records the failure. The actual repair now returns PostgreSQL 55P03 on contention and
preserves the index; the isolated test exercises recovery as well as successful/idempotent runs.

Production rollout is operator-owned; local regression commands never deploy to production:

1. Create and verify a fresh production backup. Schedule the index drop when briefly blocking
   both reads and writes is acceptable; use the direct/unpooled URL without printing credentials.
2. From the reviewed release, run `npm run migrate:deploy`, then `npx prisma migrate status`.
3. Run `npm run db:check-item-indexes` against the same database. This command opens a read-only
   transaction, compares `public.items` indexes with the Item schema, and exits nonzero for an extra
   UNIQUE (even if renamed), missing indexes, or changed definitions. Full canonical
   `pg_get_indexdef` is compared, including key order, sort/null order, operator classes, collation,
   INCLUDE columns, method and predicates, in addition to unique/primary/valid flags. It never
   repairs drift.
4. Deploy the application containing nonblocking add feedback. In a test shopping list, add the
   same variant twice: both requests must succeed and both rows/badges must remain visible.
   Verify that an add error stays inline, preserves selection, and opens no native alert.

Stop rollout if migration or verification fails. Do not recreate the old UNIQUE on code rollback:
duplicate shopping rows are intentional and may already exist after rollout. Keep the compatible
schema repair; a data restore is a separate operator decision, not an automatic rollback step.

On lock timeout, do not loop deploy or kill application sessions blindly. Verify from a fresh
connection that the legacy index still exists and inspect `prisma migrate status` / the failed
migration receipt. Release the blocker normally or wait for a quieter window. Prisma records the
failed attempt and blocks later deploys: after verification, mark **only this failed attempt**
rolled back with `npx prisma migrate resolve --rolled-back 20261102224241_drop_legacy_item_variant_unique`,
then retry `npm run migrate:deploy` in that quiet window and repeat status/drift verification.
Do not mark it applied merely to bypass the failure. A code rollback remains compatible with the
removed index; restoring uniqueness is neither required nor safe after duplicate rows exist.

Local checks (after `npm ci`, with a local `.env`, never a production URL):

- `npm run test:items-postgres`: real item POST handler against `clickmoji-local-pg` on loopback:5432;
  randomly named fixtures only, no truncate/reset. Covers successive requests, one batch, and null
  variants. Run before/after the migration to observe the constraint regression.
- `npm run db:check-item-indexes`: expected indexes are `items_pkey` (unique id), `items_listId_idx`,
  and `items_productId_idx` (both nonunique).
- `npm run test:repair-postgres`: owns a fresh database inside `clickmoji-local-pg`, never the
  restored public schema. Runs Prisma transaction probes, holds a conflicting reader lock, checks
  timeout/index preservation, resolve/retry, reset policy, and repeats the exact SQL twice. Also
  creates partial/hash/DESC/null-order/opclass/collation/INCLUDE drift and runs the actual scanner.
  `-- --baseline` reads the exact old `aae343d` migration/scanner from Git for RED receipts;
  add `--drift-only` to exercise the old scanner separately. Scratch DB/files are removed in finally.
- `npm run test:e2e:variants`: opt-in local DB suite, isolated fixture users, production build/server
  on port 3136, Chromium and WebKit with 375px touch emulation. Successful adds use the real local
  API. Injected 500/403/network failures test inline feedback, preserved selection and successful
  retry. The native-dialog invariant is “no dialog at all”; the sampled former OK-area tap is not
  proof of OS-native dialog geometry or of the original physical-phone ghost click.

Add retry contract: category/favorites selection POSTs are atomic (validated batch, one database
transaction), so no per-item partial response is invented: a failed batch remains selected and is
retried as that whole failed operation. FavoritesSection's item-add and usage-counter update are
separate operations: after item success/usage failure, feedback explicitly says the item was added,
and the counter retry never sends another item POST. Deliberate duplicate adds remain available.
AI create/add similarly retains the created product for add-only retry. Cache/callback housekeeping
failure cannot relabel a committed write as an add failure. The separate text-import endpoint can
return a true added/failed report: partial results stay open and retry prepares only failed names
for user review, never the original successful entries. Its existing failed DTO lacks quantities/
notes, so the UI explicitly asks the shopper to review those before resubmitting.

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
  - `migrate-data` requires `DB_TRANSFER_SOURCE_URL` (source database) and `DB_TRANSFER_TARGET_URL` (target database); neither has a default value.

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
