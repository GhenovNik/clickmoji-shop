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
- Backup **local development** DB (plaintext, to the gitignored `backups/*.dump`; local only, never production): `npm run db:backup`
- Restore **local development** DB from the latest local backup (local only): `npm run db:restore`
- Restore **local development** DB from a specific local file (local only): `npm run db:restore -- clickmoji-YYYYMMDD-HHMMSS.dump`
- Both run `pg_dump` / `pg_restore` in the `postgres:17-alpine` image: production is PostgreSQL 17.11
  and a `pg_dump` 16 client refuses a 17 server.
- Production backups must be encrypted, access-controlled, monitored, and restore-tested.
- Do not store production database copies in GitHub in any form: not as Actions artifacts (short-term ones included), releases, caches or repository files, even encrypted. The earlier allowance for short-term ordinary artifacts is withdrawn; GitHub takes no part in copying. Existing production copies there are removed under task A, not kept as a fallback.
- Before a production migration, create and verify a fresh backup, run `prisma migrate deploy` with
  a direct/unpooled database URL, and confirm `prisma migrate status` afterwards.

### Production recovery

Never restore into the live database. Restore to a separate target, check it against expectations written down
before the incident, fence production, account for every change after the recovery point, and only then point the
production `DATABASE_URL` at the target. Keep the old database until the operator approves its retirement. A failed
check at any step blocks the next step. Record decisions and check outputs in the incident ticket, never credentials.

Terms used below:

- **Recovery point (RP)**: the instant the restored data represents.
  - Point-in-time branch: `RECOVERY_TIME`, the parent timestamp of the branch, confirmed by reading the branch back.
  - Encrypted copy: the `createdAt` field of its record (`meta/<copy>.json`, next to the copy). `createdAt` is the
    **start** of the backup run, written before the dump is taken, and the dump's snapshot is taken at or after it.
    It is therefore an earlier boundary of the stated loss window: a change committed between `createdAt` and the
    snapshot is inside the copy, so widening the window to `createdAt` can never hide a change. The copy's contents
    are compared exactly with frozen production (_Post-point changes_), whatever the boundary.
    Never use the file's modification time, its upload time or any later time. If `createdAt` cannot be read, use an
    earlier boundary: 00:00:00Z of the day in the copy's name (`clickmoji-<UTC timestamp>.dump.age`).
- **Expectations**: what a correct target must look like, taken from the **compatible release** (the release whose
  migrations were known-good for the data being recovered, normally the one live just before the bad migration), not
  from current production. Current production may already contain the bad migration, so comparing against it proves
  nothing. See _Write the expectations_.
- **Fence**: the state in which no process can change production data. It is enforced by the operator (stopping
  writers, closing sessions) and verified in the database by the checks in _Fence production_. It is not a grant
  change: revoking table privileges does not cover the owner role, grants through `PUBLIC` or inherited role
  memberships, other schemas, superusers, or background writers, so the procedure does not rely on it.
- **Frozen production**: production after the fence is verified. Its data no longer changes, so a comparison against
  it is complete, including deletes. `FROZEN_AT` is the time of the last passing fence check.
- **Writers**: every process or person that can change production data: the production Vercel deployments of `master`
  and any older deployment still serving requests or running background work (including scheduled functions);
  operator scripts with a write command (`scripts/catalog-cleanup.ts`, `scripts/emoji-import.ts --apply`, the write
  commands of `scripts/db-*.ts` and `scripts/db-transfer.ts`); the GitHub workflow `Production migration`
  (`migrate-production.yml`) and any `prisma migrate deploy` run; database-side jobs (`pg_cron`, if installed); and
  any other client that holds a production URL or a role with write privileges. Preview deployments never hold a
  production URL. The scheduled backup workflow (`db-backup.yml`) only reads, but it is paused for the window so that
  the session check sees no unidentified connection.
- **Owner role** (`<owner-role>`): owns the restored target. Used for restore, verification and the grant checks. It
  is never the site's `DATABASE_URL`.
- **Runtime role** (`<runtime-role>`): the role in the site's production `DATABASE_URL`. It is not an owner, not a
  superuser, has no `CREATEROLE`, `CREATEDB` or `BYPASSRLS`, owns no object, and cannot create objects in `public`.

#### Shell and prerequisites

- Commands are written for **zsh or bash**. Hidden input uses `printf` followed by `read -rs NAME`, which works in
  both; do not use the zsh-only `read -rs 'NAME?prompt'` form.
- Needed: Docker running on the operator machine; the Neon CLI (`neon`, version 4.9.0 or newer, `neon --version`)
  authenticated by the operator; Node.js 24; and a clean checkout of the compatible release (see _Write the
  expectations_). Nothing is installed on the host by these steps; `age` and PostgreSQL clients run inside the
  disposable containers.
- The Neon flags in this section were written against the CLI reference. Before each run, check them with
  `neon branches create --help` and `neon connection-string --help` on the operator's version, and stop if a flag is
  missing.
- Use the same PostgreSQL image digest as the one below for every container.
- Every `docker run` below passes `--log-driver none`. Without it the daemon keeps container stdout and stderr,
  including the printed age identity, in its own log outside this terminal.
- Connection values never appear in argv. Containers receive `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
  `PGSSLMODE`, `PGCHANNELBINDING`, `PGOPTIONS` and `PGAPPNAME` **by name** (`-e NAME`), with values from this shell's
  environment.
  The only connection-related argument is the database name in `pg_restore --dbname "$PGDATABASE"`, which is not a
  secret.
- Connection URLs are entered with a hidden prompt or captured from a command's output into a shell variable. They are
  never typed into a command, a file, a log or a ticket.
- Work only in a private terminal: no shell tracing (`set -x`), no session recording, no shared screens.

```sh
IMAGE='postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'
NEON_PROJECT_ID='<neon-project-id>'
PROD_BRANCH='<production-branch-name>'   # the project's default branch; confirmed in _Create the target_

# Runs the pinned image with the libpq variables forwarded by name. Add -i only when stdin carries SQL or
# the age identity; without it a command that reads the terminal could hang.
pg_run() {
  docker run --rm --log-driver none \
    -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD -e PGSSLMODE -e PGCHANNELBINDING -e PGOPTIONS -e PGAPPNAME \
    "$@"
}

# Sets the libpq variables from a postgres:// URL passed as $1, exported and never printed. The conversion is
# self-contained (Node.js, no repository file). It fails closed on any query parameter other than sslmode and
# channel_binding, on any TLS mode other than require, verify-ca or verify-full, and on a missing database, user
# or password. Its error messages never contain the URL. The URL is only a function argument and the environment
# of the Node.js process; it is not in any argv.
load_libpq_env() {
  unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGCHANNELBINDING PGOPTIONS
  _libpq=$(LIBPQ_URL=$1 node --input-type=module <<'JS'
let u;
try {
  u = new URL(process.env.LIBPQ_URL);
} catch {
  throw new Error('not a URL');
}
if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('not a PostgreSQL URL');
for (const key of u.searchParams.keys()) {
  if (key !== 'sslmode' && key !== 'channel_binding') throw new Error(`unsupported parameter ${key}`);
}
const sslmode = u.searchParams.get('sslmode');
if (!['require', 'verify-ca', 'verify-full'].includes(sslmode)) throw new Error('TLS mode required');
const env = {
  PGHOST: u.hostname,
  PGPORT: u.port || '5432',
  PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGSSLMODE: sslmode,
};
if (u.searchParams.has('channel_binding')) env.PGCHANNELBINDING = u.searchParams.get('channel_binding');
if (!env.PGDATABASE || !env.PGUSER || !env.PGPASSWORD) throw new Error('database, user and password required');
for (const [key, value] of Object.entries(env)) console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`);
JS
  ) || return 1
  eval "$_libpq"
  unset _libpq
}

# Read-only production session: the same variables, with the session forced read-only. Used for every read of
# production in this section. PROD_READONLY_URL is a role that can only read (ideally with pg_read_all_stats).
prod_ro() {
  ( load_libpq_env "$PROD_READONLY_URL" && export PGOPTIONS='-c default_transaction_read_only=on' && "$@" )
}
```

The read-only URL is entered once, without echo, and stays in this shell:

```sh
printf 'Read-only production URL (not echoed): '
read -rs PROD_READONLY_URL
echo
```

#### Queries used below

These definitions are used unchanged by every check. They run identically on production, the target and the
reference database, so their outputs can be compared line by line.

```sh
# Every user table and partitioned table in every user schema, with column names, types and nullability.
IDENTITY_SQL="SELECT format('%I.%I', n.nspname, c.relname) || E'\t' || string_agg(format('%I %s %s', a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE 'NULL' END), ',' ORDER BY a.attnum)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
GROUP BY n.nspname, c.relname
ORDER BY 1;"

# Exact count(*) per table, keyed schema.table, tab-separated.
COUNTS_SQL="SELECT format('%I.%I', n.nspname, c.relname) || E'\t' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY 1;"

# Latest applied Prisma migration, ordered as Prisma orders them.
MIGRATION_SQL="SELECT migration_name FROM public._prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name DESC LIMIT 1;"

# Sequence positions (a sequence advances on writes that the write counter below does not show).
SEQUENCE_SQL="SELECT schemaname || '.' || sequencename || E'\t' || coalesce(last_value::text, 'null')
FROM pg_sequences
WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_toast%'
ORDER BY 1;"

# Write counter: rows inserted, updated or deleted through the statistics, all user schemas. It lags and it does not
# count TRUNCATE, so it is a sanity check; the comparison in _Post-point changes_ is the real evidence.
WRITE_COUNTER_SQL="SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) AS write_counter FROM pg_stat_user_tables;"

# Effective privileges of one role on every user relation, including inherited grants, PUBLIC and role membership.
# Run it from stdin (psql -f -) with -v role=...: psql does not substitute :'role' inside -c strings.
GRANTS_SQL="SELECT n.nspname || '.' || c.relname || E'\t' || c.relkind::text || E'\t' || p.priv
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  AND has_table_privilege(:'role', c.oid, p.priv)
UNION ALL
SELECT n.nspname || '.' || c.relname || E'\t' || c.relkind::text || E'\t' || p.priv
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS p(priv)
WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  AND has_sequence_privilege(:'role', c.oid, p.priv)
ORDER BY 1;"

# Every user relation the role owns or inherits ownership of. Must return no rows for the runtime role.
OWNERSHIP_SQL="SELECT n.nspname || '.' || c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  AND pg_has_role(:'role', c.relowner, 'USAGE');"
```

#### Write the expectations

Record these in the incident ticket **before** any target is created. Each one is checked against the target; a
mismatch blocks the recovery.

1. **`COMPATIBLE_RELEASE`**: the git tag or commit of the compatible release. Check it out into a clean directory
   of its own (for example `git worktree add <dir> <commit>`) and set:

   ```sh
   COMPAT_DIR='<absolute path to the clean checkout of COMPATIBLE_RELEASE>'
   # Latest migration of that release. Same ordering as migration_name DESC in MIGRATION_SQL.
   EXPECTED_MIGRATION=$(ls -1 "$COMPAT_DIR/prisma/migrations" | grep -v '^migration_lock.toml$' | LC_ALL=C sort | tail -1)
   printf 'EXPECTED_MIGRATION=%s\n' "$EXPECTED_MIGRATION"
   ```

2. **`EXPECTED_IDENTITY`**: the schema the compatible release produces, built from its own migrations in a disposable
   PostgreSQL container that the operator owns. It is bound to loopback, uses no password, and is removed at the end.
   It is not production, not an existing container and not a shared image.

   ```sh
   REF_NAME="ref-$(date -u +%Y%m%d%H%M%S)"
   EXP_DIR=$(mktemp -d "$HOME/recovery-expect-XXXXXX") && chmod 700 "$EXP_DIR"
   docker run -d --rm --log-driver none --name "$REF_NAME" \
     -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 "$IMAGE" > /dev/null
   until docker exec "$REF_NAME" pg_isready -q -U postgres; do sleep 1; done
   ( cd "$COMPAT_DIR" && npm ci && DATABASE_URL='postgresql://postgres@127.0.0.1:55432/postgres' npx prisma migrate deploy )
   docker exec "$REF_NAME" psql -X -q -A -t -U postgres -d postgres -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" > "$EXP_DIR/identity.tsv"
   docker exec "$REF_NAME" psql -X -q -A -t -U postgres -d postgres -v ON_ERROR_STOP=1 -c "$MIGRATION_SQL" > "$EXP_DIR/migration.txt"
   docker stop "$REF_NAME" > /dev/null
   EXPECTED_IDENTITY_SHA=$(shasum -a 256 "$EXP_DIR/identity.tsv" | cut -d' ' -f1)
   printf 'EXPECTED_IDENTITY_SHA=%s\n' "$EXPECTED_IDENTITY_SHA"
   ```

   The reference migration (`$EXP_DIR/migration.txt`) must equal `EXPECTED_MIGRATION`; otherwise stop.

3. **`EXPECTATIONS`**: incident-specific data checks. Each one is a read-only query on the target with an expected
   value and the evidence for that value. The evidence must come from before the bad change (for example a count
   recorded before the migration ran, or a verified copy taken before it), never from the current production state.
   Example rows (replace them with the incident's own):

   | id  | read-only check on the target                                        | expected | evidence for the expected value                     |
   | --- | -------------------------------------------------------------------- | -------- | --------------------------------------------------- |
   | E1  | `SELECT count(*) FROM public."<table>" WHERE "<column>" = '<value>'` | `<n>`    | count in the ticket, taken before `<migration>` ran |
   | E2  | `SELECT count(*) FROM public."<table>"`                              | `<n>`    | count in the ticket, taken before `<migration>` ran |

   A check passes only when the output equals the expected value exactly. Any failed check, or a missing expectation,
   stops the recovery.

#### Create the target

Each option creates a **new** target, never the production database. Confirm the Neon project and the target branch
in the Neon console before continuing.

1. **Point-in-time branch.** Use a time before the incident, inside Neon's restore window for the plan.

   ```sh
   RECOVERY_TIME='<RFC 3339 UTC time before the bad change, e.g. 2026-11-24T10:00:00Z>'
   RECOVERY_BRANCH='recovery-<incident-id>'
   neon branches list --project-id "$NEON_PROJECT_ID" --output json
   ```

   From that list, confirm that `$PROD_BRANCH` is the project's default branch and note its id. Then create the branch
   from production at the recovery time, and read it back:

   ```sh
   neon branches create --project-id "$NEON_PROJECT_ID" --name "$RECOVERY_BRANCH" --parent "$PROD_BRANCH@$RECOVERY_TIME" --no-secrets
   neon branches list --project-id "$NEON_PROJECT_ID" --output json
   ```

   The read-back must show, for `$RECOVERY_BRANCH`: `parent_id` equal to the id of `$PROD_BRANCH`, and the parent
   timestamp equal to `RECOVERY_TIME`. If either differs, or the field is missing, delete only `$RECOVERY_BRANCH`
   (the branch this procedure created), record the reason, and stop. Record the parent id and timestamp in the ticket.
   Then capture the direct owner URL into a variable (not printed):

   ```sh
   TARGET_URL=$(neon connection-string "$RECOVERY_BRANCH" --project-id "$NEON_PROJECT_ID" --database-name '<database-name>' --role-name '<owner-role>')
   load_libpq_env "$TARGET_URL"
   ```

   `--no-secrets` keeps the connection string out of the create command's output. The direct URL (no `--pooled`) is
   the restore role's.

2. **Encrypted copy.** A Neon branch inherits its parent's databases, so create a new database inside a new branch
   and use only that database. It must be verified empty (below) before any restore.

   ```sh
   RESTORE_BRANCH='restore-<incident-id>'
   RESTORE_DB='<new-database-name>'
   neon branches create --project-id "$NEON_PROJECT_ID" --name "$RESTORE_BRANCH" --no-secrets
   neon databases create --project-id "$NEON_PROJECT_ID" --branch "$RESTORE_BRANCH" --name "$RESTORE_DB" --owner-name '<owner-role>'
   TARGET_URL=$(neon connection-string "$RESTORE_BRANCH" --project-id "$NEON_PROJECT_ID" --database-name "$RESTORE_DB" --role-name '<owner-role>')
   load_libpq_env "$TARGET_URL"
   ```

3. **Neon unavailable.** Provision PostgreSQL 17 with a fresh empty database and TLS at another provider (the
   provider's own steps are not covered here). Enter its direct URL without echo:

   ```sh
   printf 'Direct URL of the NEW empty database (not echoed): '
   read -rs TARGET_URL
   echo
   load_libpq_env "$TARGET_URL"
   ```

`load_libpq_env` stops with an error for a URL it cannot represent exactly. Treat that as a blocker, not as a reason to
edit the URL by hand. `TARGET_URL` stays a shell variable and is removed when the procedure ends.

#### Container and key preparation (encrypted copy only)

The age identity is created once, by the operator, on a trusted machine. Its private key is printed to the terminal
only: do not redirect the output and do not save it as a file. Record it directly in the password manager and on
paper, and give only the `age1...` public recipient to the backup configuration. Do not share the private key, record
the terminal, or use a newly generated key to decrypt an existing copy.

```sh
docker run --rm --log-driver none "$IMAGE" sh -c 'apk add --no-cache age >/dev/null && age-keygen'
```

`age-keygen` writes the private key to standard output and the `Public key:` line to standard error; both appear on
screen. `--log-driver none` keeps them out of the daemon log.

#### Empty-target check (encrypted copy, before any restore)

Run it against the database created above. Expected result: `(0 rows)`. Any row, or a failed connection, stops the
procedure. Independently confirm that the provider, project, branch and database are the intended new target.

```sh
pg_run -i "$IMAGE" sh -c 'psql -X -v ON_ERROR_STOP=1 -f -' <<'SQL'
SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S');
SQL
```

#### Restore the encrypted copy

Set the placeholders in the private terminal. `BACKUP_DIR` must be an absolute path to the directory that holds the
copy and its `meta/` directory. The directory is mounted read-only. `TARGET_URL` must be the new empty database from
the previous step, never production. The libpq variables come from it through `load_libpq_env` and reach the
container by name only.

```sh
BACKUP_DIR='<absolute-directory-containing-the-encrypted-copy>'
BACKUP_FILE='clickmoji-<UTC timestamp>.dump.age'
RECORD="$BACKUP_DIR/meta/$BACKUP_FILE.json"
export BACKUP_DIR BACKUP_FILE RECORD
printf 'Age private identity (not echoed): '
read -rs AGE_IDENTITY
echo
printf '%s\n' "$AGE_IDENTITY" | pg_run -i -v "$BACKUP_DIR:/backup:ro" -e BACKUP_FILE "$IMAGE" sh -c '
  set -eu
  set -o pipefail
  apk add --no-cache age >/dev/null
  age -d -i /dev/stdin "/backup/$BACKUP_FILE" | pg_restore --no-owner --no-privileges --exit-on-error --dbname "$PGDATABASE"
'
RESTORE_STATUS=$?
unset AGE_IDENTITY
printf 'Restore exit: %s\n' "$RESTORE_STATUS"
```

Proceed only on `Restore exit: 0`. The identity goes in on stdin and is never written to a key file; no plaintext dump
is written by this procedure. `--dbname "$PGDATABASE"` is required: without it `pg_restore` writes SQL to standard
output instead of restoring. `unset` does not erase shell memory, so close the terminal afterwards. A restore that
stops partway is discarded and retried in another fresh empty database; it is never repaired in place.

`set -o pipefail` in the container's `sh` needs a shell that supports it (the Alpine image's `sh` is BusyBox). This is
checked by the Docker run of the drill below, not assumed.

#### The copy's record

Each encrypted copy has a record `meta/<copy>.json` written next to it. Its fields:

- `name`: the copy's file name.
- `createdAt`: the UTC start of the backup run, written before the dump was taken. This is the copy's recovery point.
- `verify`: `ok`, or `suspicious` when a table fell by more than 20% against the previous copy. `suspicious` is an
  operator decision, not a pass.
- `migration`: the latest applied migration of the copied database.
- `counts`: exact `count(*)` per table, keyed `schema.table`.
- `flagged`: tables flagged as suspicious.

Read them without printing the whole record:

```sh
RECORD_VERIFY=$(node -e 'process.stdout.write(require(process.argv[1]).verify)' "$RECORD")
RECORD_MIGRATION=$(node -e 'process.stdout.write(require(process.argv[1]).migration)' "$RECORD")
RECORD_CREATED_AT=$(node -e 'process.stdout.write(require(process.argv[1]).createdAt)' "$RECORD")
RP_CREATED_AT="$RECORD_CREATED_AT"   # the recovery point; the copy's dump snapshot is at or after it
printf 'record: verify=%s migration=%s createdAt=%s\n' "$RECORD_VERIFY" "$RECORD_MIGRATION" "$RP_CREATED_AT"
```

#### Verify the encrypted copy

Pass only when **all** of these hold, all run on the restored target:

1. restore exit is `0`, and `RECORD_VERIFY` is `ok`;
2. the table list and every count equal the record exactly (a missing or extra table blocks the recovery):

   ```sh
   TARGET_COUNTS=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$COUNTS_SQL")
   diff \
     <(node -e 'const r = require(process.argv[1]); for (const [t, n] of Object.entries(r.counts)) console.log(t + "\t" + n)' "$RECORD" | LC_ALL=C sort) \
     <(printf '%s\n' "$TARGET_COUNTS" | LC_ALL=C sort) && echo "counts: exact match"
   ```

3. the target's latest migration equals `RECORD_MIGRATION` and `EXPECTED_MIGRATION`:

   ```sh
   TARGET_MIGRATION=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$MIGRATION_SQL")
   printf 'migration: record=%s target=%s expected=%s\n' "$RECORD_MIGRATION" "$TARGET_MIGRATION" "$EXPECTED_MIGRATION"
   ```

4. the target's schema equals the reference: the identity's SHA-256 equals `EXPECTED_IDENTITY_SHA`:

   ```sh
   pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" > "$EXP_DIR/target-identity.tsv"
   [ "$(shasum -a 256 "$EXP_DIR/target-identity.tsv" | cut -d' ' -f1)" = "$EXPECTED_IDENTITY_SHA" ] && echo "schema: matches the compatible release"
   ```

5. every `EXPECTATIONS` check passes.

If the record's `verify` is `suspicious`, or the record's migration differs from `EXPECTED_MIGRATION`, stop and decide
as an operator. Do not run `prisma migrate deploy` against restored data.

#### Verify the point-in-time branch

A branch has no record and no counts to compare exactly, and production today is not the reference (it may already
contain the bad change). The branch is checked against the **expectations**, never against production's current
schema or migration, and it does not need any copy record.

Pass only when **all** of these hold, all run on the branch:

1. the branch's parent and parent timestamp were confirmed in _Create the target_ (recorded in the ticket);
2. the schema identity equals the reference's, line for line:

   ```sh
   pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" > "$EXP_DIR/branch-identity.tsv"
   diff "$EXP_DIR/identity.tsv" "$EXP_DIR/branch-identity.tsv" && echo "schema: matches the compatible release"
   ```

   A difference means the branch does not hold the compatible release's schema: stop and decide.

3. the latest migration equals `EXPECTED_MIGRATION` (`pg_run "$IMAGE" psql -X -q -A -t -c "$MIGRATION_SQL"`);
4. every `EXPECTATIONS` check passes;
5. `prisma migrate status` reports the compatible release's migrations as applied, run from `COMPAT_DIR` with its
   dependencies installed. `prisma.config.ts` falls back to a localhost URL when `DATABASE_URL` is unset, so it must
   be set explicitly:

   ```sh
   ( cd "$COMPAT_DIR" && DATABASE_URL="$TARGET_URL" npx prisma migrate status )
   ```

Inspect representative users, lists and products without exposing personal data, and test sign-in and reading a test
list against the target in an isolated preview. Do not seed restored data.

#### Fence production

Order matters, and it is fixed:

1. stop writers (step 1 below);
2. verify the fence (step 2), until it passes;
3. record the counters from frozen production (step 3);
4. only then deploy anything to Vercel, or let anything write to the target.

Step 1: **stop every writer** and record each one in the ticket with the method used and the time. Writers are listed
in the terms above. The operator's methods, for example:

- Vercel: put production into maintenance by the operator's method (for example a promoted maintenance deployment that
  has no database access), and confirm that no older production deployment still serves requests or runs scheduled
  work;
- GitHub: disable runs of `migrate-production.yml`, pause the scheduled `db-backup.yml` for the window, and confirm no
  run is in progress;
- operator scripts: stop any running command that can write;
- database-side jobs: if the `pg_cron` extension is installed, stop its jobs by the operator's method. Do not use an
  `UPDATE` on the job table to stop them, because that is itself a write.

Step 2: **verify the fence**. Run these checks at least two minutes apart. **All** must hold on each run.

- **Sessions.** Read every client session with a role that can see all sessions (`pg_read_all_stats`; a role that cannot
  sees only its own sessions, and an empty result then proves nothing). The verification sessions are the operator's and
  carry the application name `clickmoji-verify-<incident-id>` (`PGAPPNAME`, forwarded into the containers by `pg_run`).
  Set it once in the verification shell: `export PGAPPNAME='clickmoji-verify-<incident-id>'`. The result must be empty
  apart from those sessions:

  ```sql
  SELECT pid, usename, application_name, client_addr, state, backend_start
  FROM pg_stat_activity
  WHERE datname = current_database() AND backend_type = 'client backend'
    AND application_name <> 'clickmoji-verify-<incident-id>';
  ```

  Idle and pooled connections count, because they can start a write at any time. Any row that belongs to a writer that
  was stopped may be closed with `SELECT pg_terminate_backend(pid);`, which rolls back its open transaction. Committed
  changes are not undone; they are post-point changes and are found by the comparison below. Any row that is not
  identified (not in the ticket) stops the procedure.

- **Write-capable roles.** Every login role with write-capable effective privileges on a user table in any user schema,
  including superusers, owners, role-membership and `PUBLIC` grants. Each listed role must be `<owner-role>`,
  `<runtime-role>` or an identified operator role, and must have no session under the first check:

  ```sql
  SELECT r.rolname, r.rolsuper, count(c.oid) AS write_relations
  FROM pg_roles r
  JOIN pg_class c ON c.relkind IN ('r', 'p')
  JOIN pg_namespace n ON n.oid = c.relnamespace
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  WHERE r.rolcanlogin
    AND (has_table_privilege(r.oid, c.oid, 'INSERT') OR has_table_privilege(r.oid, c.oid, 'UPDATE')
         OR has_table_privilege(r.oid, c.oid, 'DELETE') OR has_table_privilege(r.oid, c.oid, 'TRUNCATE')
         OR pg_has_role(r.oid, c.relowner, 'USAGE'))
  GROUP BY r.rolname, r.rolsuper
  ORDER BY 1;
  ```

  A superuser cannot be fenced by grants at all. For it the only evidence is zero sessions and a credential that the
  operator has stopped using. Record any unexpected role and stop until it is explained.

- **Background writers inside the database.** If `pg_cron` is installed, the list of its active jobs is empty or every
  job is stopped (recorded in the ticket). Subscriptions that write into this database are listed and stopped by the
  operator.

- **Counters stable.** `WRITE_COUNTER_SQL` and `SEQUENCE_SQL` give the same output on both runs two minutes apart.

Step 3: **record the counters from frozen production**, read through `prod_ro`, after step 2 has passed on the run
that defines `FROZEN_AT`:

```sh
FROZEN_AT='<UTC time of the last passing fence check>'
WRITE_BASELINE=$(prod_ro pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<< "$WRITE_COUNTER_SQL")
SEQUENCE_BASELINE=$(prod_ro pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<< "$SEQUENCE_SQL")
PRE_STOP_COUNTS=$(prod_ro pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$COUNTS_SQL")
PRE_STOP_IDENTITY_SHA=$(prod_ro pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" | shasum -a 256 | cut -d' ' -f1)
printf 'FROZEN_AT=%s write_baseline=%s identity=%s\n' "$FROZEN_AT" "$WRITE_BASELINE" "$PRE_STOP_IDENTITY_SHA"
```

Record `FROZEN_AT`, `WRITE_BASELINE`, `SEQUENCE_BASELINE`, `PRE_STOP_COUNTS` and `PRE_STOP_IDENTITY_SHA` in the ticket.
They are the old database's state for the rollback check.

Limits, stated in the ticket: the fence is operator-enforced. The checks prove that no session exists and that the
write counters are stable; they do not prove that a writer holding no session cannot act later. That is why writers are
stopped by their own methods in step 1 and why the final check is repeated before any target is written.

#### Post-point changes (full comparison with frozen production)

Timestamp columns cannot find deleted rows or changes made by raw SQL. The comparison is therefore by content, and it
does not depend on any boundary: every row of every user table in every user schema is hashed (`md5` of the row as
text), the hash lists of production and of the target are sorted, and `comm` compares them. Production is frozen, so
the comparison is complete for the target's actual contents, whatever its snapshot time:

- a row **only in production** was created or changed after the target's state (after the recovery point, or after a
  copy's snapshot);
- a row **only in the target** existed in the target and was deleted, or changed, in production;
- an updated row appears once on each side.

The recovery point (`RP_CREATED_AT` for a copy, `RECOVERY_TIME` for a branch) only states the loss window in the ticket
and the approval. Whatever it is, the lists below are what the switch would lose or re-introduce.

Schema differences are checked first. A table whose identity differs between production and the target (for example one
changed by the bad migration) cannot be meaningfully compared row by row. It is listed as **schema differs** and needs an
explicit operator decision; it is not reconciled automatically.

```sh
DIFF_DIR=$(mktemp -d "$HOME/recovery-diff-XXXXXX") && chmod 700 "$DIFF_DIR"
prod_ro pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" > "$DIFF_DIR/identity-prod.txt"
load_libpq_env "$TARGET_URL"
pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" > "$DIFF_DIR/identity-target.txt"
echo 'schema differs:'
LC_ALL=C comm -3 <(LC_ALL=C sort "$DIFF_DIR/identity-prod.txt") <(LC_ALL=C sort "$DIFF_DIR/identity-target.txt") \
  | sed 's/^\t//' | cut -f1 | LC_ALL=C sort -u
# One UNION ALL of per-table row hashes, generated from the catalogue and executed with \gexec.
ROWHASH_SQL="SELECT string_agg(format('SELECT %L AS table_name, md5(x::text) AS row_md5 FROM %I.%I AS x', n.nspname || '.' || c.relname, n.nspname, c.relname), ' UNION ALL ' ORDER BY n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' \gexec"
prod_ro pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<< "$ROWHASH_SQL" > "$DIFF_DIR/prod.txt"
load_libpq_env "$TARGET_URL"
pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<< "$ROWHASH_SQL" > "$DIFF_DIR/target.txt"
LC_ALL=C sort "$DIFF_DIR/prod.txt" > "$DIFF_DIR/prod.sorted"
LC_ALL=C sort "$DIFF_DIR/target.txt" > "$DIFF_DIR/target.sorted"

echo 'created or changed after RP (only in production):'
LC_ALL=C comm -23 "$DIFF_DIR/prod.sorted" "$DIFF_DIR/target.sorted" | cut -d'|' -f1 | LC_ALL=C sort | uniq -c
echo 'deleted or changed after RP (only in target):'
LC_ALL=C comm -13 "$DIFF_DIR/prod.sorted" "$DIFF_DIR/target.sorted" | cut -d'|' -f1 | LC_ALL=C sort | uniq -c
```

The `prod.txt` and `target.txt` files are rows of `table|md5`; they hold no row data. The `prod_ro` subshell loads the
read-only production URL; the target then loads `TARGET_URL` in the main shell.

Also compare the sequence positions. Every sequence of frozen production must exist in the target with a `last_value` at
least as large, so ids used by production rows are never reused after writes resume. The command prints nothing when
the check passes:

```sh
TARGET_SEQUENCES=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$SEQUENCE_SQL")
printf '%s\n' "$SEQUENCE_BASELINE" > "$DIFF_DIR/sequences-prod.txt"
printf '%s\n' "$TARGET_SEQUENCES" > "$DIFF_DIR/sequences-target.txt"
awk -F '\t' 'NR == FNR { tgt[$1] = $2; next } { if (!($1 in tgt)) print "missing in target: " $1; else if (tgt[$1] + 0 < $2 + 0) print "behind: " $1 }' \
  "$DIFF_DIR/sequences-target.txt" "$DIFF_DIR/sequences-prod.txt"
```

The counts in the two lists are the **decision input**. Write the decision in the ticket before any switch, with one of:

- **Reconcile.** Export the rows only in production, and the rows only in the target that must be removed, to the
  operator's encrypted private storage (never GitHub). Review them. Apply them to the target as the owner role: insert or
  update the production rows, delete the target-only rows. Tables marked **schema differs** are handled by hand, one
  table at a time. Then run the comparison again: it must show only the rows that the decision keeps. Advance any
  sequence that is behind. Or
- **Accept loss.** A written approval by the operator that names: the per-table counts of both lists, `RP`,
  `FROZEN_AT`, the schema-differs tables, and the limit that the comparison cannot see rows that were changed and changed
  back again between the recovery point and `FROZEN_AT`.

Without one of these decisions, the switch does not happen. This is a question for the operator, not a default.

#### Runtime role on the target (before the switch)

The site must reach the target as the runtime role, never as the owner role. The runtime role is created on the target
by the operator with the provider's own method, and its password is set without echo. Its privileges must match
production's, across all user schemas (not only `public`), and it must own nothing.

```sh
# The same GRANTS_SQL and OWNERSHIP_SQL run on production (read-only) and on the target (owner role):
# the outputs must be identical, and OWNERSHIP_SQL must return no rows.
export RUNTIME_ROLE='<runtime-role>'
ROLE_PSQL='psql -X -q -A -t -v ON_ERROR_STOP=1 -v role="$RUNTIME_ROLE" -f -'
prod_ro pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$ROLE_PSQL" <<< "$GRANTS_SQL" > "$DIFF_DIR/grants-prod.txt"
load_libpq_env "$TARGET_URL"
pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$ROLE_PSQL" <<< "$GRANTS_SQL" > "$DIFF_DIR/grants-target.txt"
diff "$DIFF_DIR/grants-prod.txt" "$DIFF_DIR/grants-target.txt" && echo "grants: identical"
test -z "$(pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$ROLE_PSQL" <<< "$OWNERSHIP_SQL")" && echo "ownership: none"
```

Then build the runtime URL and check that it reaches the target as the runtime role. Its attributes must be `f` for
`rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolbypassrls` and `can_create_in_public`:

```sh
CUTOVER_URL=$(neon connection-string "$RESTORE_BRANCH" --project-id "$NEON_PROJECT_ID" --database-name "$RESTORE_DB" --role-name '<runtime-role>' --pooled)
# For a point-in-time branch use "$RECOVERY_BRANCH" and its database instead.
load_libpq_env "$CUTOVER_URL"
pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<'SQL'
SELECT current_database(), current_user, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public
FROM pg_roles WHERE rolname = current_user;
SQL
```

Expected: `<database>|<runtime-role>|f|f|f|f|f`. Anything else stops the switch.

#### Vercel production-only setting

- In the Vercel dashboard (Project Settings → Environment Variables), confirm that the existing `DATABASE_URL` entry is
  scoped to **Production only**. If it also covers Preview or Development, stop: updating the entry changes every
  environment that it covers. Split the entry in the dashboard first; that is an operator action.
- Run the CLI from the linked release checkout and confirm `.vercel/project.json` names the Clickmoji production project.

#### Switch (real incident only, after every check and decision above)

Preconditions, all recorded in the ticket: the target passed its verification (copy or branch), the fence passed on the
run that defines `FROZEN_AT`, the counters above are recorded, the post-point decision is written, and the runtime-role
checks passed.

1. Record `TARGET_BASELINE` **before** any Vercel change, while the target has no writer: its write counter, its
   sequence positions and its counts, all read as the owner role. Confirm in the same session, with a role that can see
   all sessions, that the target has no client session other than the operator's (the sessions query from _Fence
   production_ with `datname` of the target):

   ```sh
   load_libpq_env "$TARGET_URL"
   TARGET_BASELINE_WRITES=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$WRITE_COUNTER_SQL")
   TARGET_BASELINE_SEQUENCES=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$SEQUENCE_SQL")
   TARGET_BASELINE_COUNTS=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$COUNTS_SQL")
   ```

2. Store the current production `DATABASE_URL` value in the password manager (the value, not in a file or a ticket), so the
   old target can be restored in one step.
3. Update the existing Vercel production variable from the linked release checkout. The value comes from stdin, never from
   argv. If the update or the deployment fails, keep writes stopped and go to _Rollback_.

   ```sh
   printf '%s' "$CUTOVER_URL" | vercel env update DATABASE_URL production --yes &&
     vercel deploy --prod
   ```

   In the Vercel dashboard, edit the existing Production variable under Project Settings → Environment Variables, then
   redeploy. Do not add a Preview or Development entry.

4. Verify the deployed site: sign-in, reading a test list, and the runtime error view in Vercel. Only then resume writes
   through the restored site. The old database stays fenced and receives no writes after the switch.
5. Record the selected copy or time, the target name (not its URL), the checks that passed, the decision used, `FROZEN_AT`,
   the switch time and the parent of the branch, without credentials.

#### Rollback

The old database is reopened only after it has been verified usable. Two cases:

- **No write has reached the target.** Check the target as the owner role: `WRITE_COUNTER_SQL`, `SEQUENCE_SQL` and
  `COUNTS_SQL` equal `TARGET_BASELINE_WRITES`, `TARGET_BASELINE_SEQUENCES` and `TARGET_BASELINE_COUNTS`. If they match,
  put the saved URL back in the Production variable and redeploy:

  ```sh
  printf 'Old production URL (not echoed): '
  read -rs OLD_URL
  echo
  printf '%s' "$OLD_URL" | vercel env update DATABASE_URL production --yes &&
    vercel deploy --prod
  unset OLD_URL
  ```

  Then **verify the old database independently** before lifting its fence. Use a fresh session, not the one used for the
  switch, and have a second operator read the outputs. All must hold:

  - the write counter equals `WRITE_BASELINE`, the sequence positions equal `SEQUENCE_BASELINE`, and the counts equal
    `PRE_STOP_COUNTS`;
  - the identity's SHA-256 equals `PRE_STOP_IDENTITY_SHA`;
  - the runtime role connects and returns the row from the runtime-role check above;
  - no session other than the operator's and the verifier's is present.

  Only when all of these hold, reopen the old database: restore writers in the reverse order of the fence, and record
  the time. If any check differs, keep writers stopped and decide. A difference means a writer got past the fence.

- **Writes have reached the target.** There is no blind rollback. Writes made on the target must first be reconciled into
  the old database, using the same comparison in the opposite direction and the same decision process, before the old
  database is verified and reopened. Rolling back without that loses them.

Do not mark or delete the old target while a rollback is still possible. If any step fails, keep the old setting and
investigate before any further change. Finally, unset the variables and remove temporary targets and files when they
are no longer needed:

```sh
unset TARGET_URL CUTOVER_URL PROD_READONLY_URL OLD_URL RECOVERY_TIME RESTORE_DB AGE_IDENTITY
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGCHANNELBINDING PGOPTIONS
rm -rf "$DIFF_DIR" "$EXP_DIR"
```

Retain the selected encrypted copy, and the ticket's records, according to policy.

#### Recovery drill and cutover dry run

Quarterly and before the first users, use the latest verified encrypted copy and the commands above (_Create the target_
step 2, the empty-target check, the restore, _Verify the encrypted copy_, and the runtime-role check) against a fresh empty
disposable database. Record the outcome and delete the disposable database. Never change site settings during a drill.

Before the first real switch, run the cutover dry run on a disposable target with a synthetic production copy: the
expectations, the fence, the counters, the comparison, the runtime checks and the rollback checks, stopping before
`vercel env update`. Use only synthetic data in own containers.

The synthetic drill must show these outcomes:

- an exact match of an encrypted copy's record passes;
- a record whose counts differ from the restored data fails the record check;
- a point-in-time branch against a reference with a different schema fails the identity check;
- in the synthetic production, after the copy's run started: one row inserted, one existing row updated and one existing
  row deleted. The comparison must report exactly two rows `only in production` (the insert and the updated row's new
  version) and exactly two `only in target` (the updated row's old version and the deleted row). A count of zero or any
  other number fails the drill.
- a table whose column was dropped in the synthetic production is listed as `schema differs`.

The Clickmoji migration and application checks apply only to an actual Clickmoji copy.

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
