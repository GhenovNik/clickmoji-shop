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

Never restore into the live database. Restore to a separate target, verify it, then point the production
`DATABASE_URL` at it in Vercel and redeploy. Keep the old target until the operator approves its retirement.
A failed check blocks the switch. The switch is not run until the decisions in _Write barrier and
reconciliation_ are recorded.

Terms used below:

- **Recovery point**: the time the restored data represents: `RECOVERY_TIME` for a point-in-time branch, or
  the `createdAt` of the verification record for an encrypted copy (`meta/<copy>.json`, next to the copy).
  Write its timestamp in the incident ticket.
- **Write stop** (`WRITE_STOP_AT`): the time production writes stop. Changes committed after the recovery
  point and before the write stop are **post-point changes**. The switch loses them unless they are
  reconciled or their loss is approved.
- **Writers**: every process that can write to production: the production Vercel deployment of `master`
  (its write routes under `src/app/api`), operator scripts that write (`scripts/catalog-cleanup.ts`,
  `scripts/emoji-import.ts --apply`, the write commands of `scripts/db-*.ts` and `scripts/db-transfer.ts`),
  `prisma migrate deploy`, and any other client that holds a production URL or role. Preview deployments
  never hold a production URL. The backup only reads.
- **Restore role** (`<owner-role>`): owns the restored target. Used for restore, verification and grants.
  It is never the site's `DATABASE_URL`.
- **Runtime role** (`<runtime-role>`): the role in the site's production `DATABASE_URL`. It is not an owner
  and not a superuser, has no `CREATEROLE`, `CREATEDB` or `BYPASSRLS`, cannot create objects in `public`,
  and holds the same table privileges as the production runtime role (checked below).

#### Shell and prerequisites

- Commands are written for **zsh or bash** (zsh is the default on the operator's Mac). Hidden input uses
  `printf` followed by `read -rs NAME`, which works in both; do not use the zsh-only `read -rs 'NAME?prompt'`
  form.
- Needed: Docker running on the operator machine; the Neon CLI (`neon`, version 4.9.0 or newer, check with
  `neon --version`) authenticated by the operator for the Neon steps; Node.js; and a checkout of the reviewed
  release that contains `scripts/backup/` (the verified backup implementation). Run the Node helper from that
  checkout's root. Nothing is installed on the host by these steps; `age` runs inside the disposable container.
- Use the same official PostgreSQL image digest as the verified backup container.
- Every `docker run` below passes `--log-driver none`. Without it the daemon keeps container stdout and
  stderr, including the printed age identity, in its own log outside this terminal. With it, `docker logs`
  has nothing to show for these containers.
- Connection values never appear in argv. Containers receive `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`,
  `PGPASSWORD`, `PGSSLMODE` and `PGCHANNELBINDING` **by name** (`-e NAME`), with values from this shell's
  environment. The only connection-related argument is the database name in `pg_restore --dbname "$PGDATABASE"`,
  which is not a secret.
- Work only in a private terminal: no shell tracing (`set -x`), no session recording, no shared screens.
  Never write a connection URL or identity into a file, a log or a ticket.

```sh
IMAGE='postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'
NEON_PROJECT_ID='<neon-project-id>'

# Runs the pinned image with the libpq variables forwarded by name. Add -i only when stdin carries SQL or
# the age identity; without it a command that reads the terminal could hang.
pg_run() {
  docker run --rm --log-driver none \
    -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD -e PGSSLMODE -e PGCHANNELBINDING -e PGOPTIONS \
    "$@"
}

# Loads the libpq variables for the URL passed as $1 into this shell, exported and never printed.
# It uses the verified backup's parser (scripts/backup/config.mjs, run from the checkout root). It fails
# closed on any URL parameter outside the allowed set and on any TLS mode other than require, verify-ca
# or verify-full. The URL itself is only an argument of this shell function; no process receives it in argv.
load_libpq_env() {
  unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGCHANNELBINDING PGOPTIONS
  _libpq=$(LIBPQ_URL=$1 node --input-type=module <<'JS'
import { libpqEnv } from './scripts/backup/config.mjs';
const env = libpqEnv(process.env.LIBPQ_URL);
const allowed = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGCHANNELBINDING'];
for (const key of Object.keys(env)) if (!allowed.includes(key)) throw new Error(`unsupported setting ${key}`);
if (!['require', 'verify-ca', 'verify-full'].includes(env.PGSSLMODE)) throw new Error('TLS mode required');
if (!env.PGDATABASE || !env.PGUSER || !env.PGPASSWORD) throw new Error('database, user and password required');
for (const [key, value] of Object.entries(env)) console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`);
JS
  ) || return 1
  eval "$_libpq"
  unset _libpq
}
```

#### Create the target

Each option creates a **new** target, never the production database. Confirm the Neon project and the target
branch in the Neon console before continuing.

1. **Recent incident (point-in-time branch).** Use a time before the incident, inside Neon's restore window
   for the plan. Confirm the production branch is the project's default first
   (`neon branches list --project-id "$NEON_PROJECT_ID"`). The branch is a copy of production at that time
   and already contains data, so it skips the emptiness check. Its verification is in
   _Verify the point-in-time branch_.

   ```sh
   RECOVERY_TIME='<RFC 3339 time before the incident, e.g. 2026-11-24T10:00:00Z>'
   RECOVERY_BRANCH='recovery-<incident-id>'
   neon branches create --project-id "$NEON_PROJECT_ID" --name "$RECOVERY_BRANCH" --parent "$RECOVERY_TIME" --no-secrets
   TARGET_URL=$(neon connection-string "$RECOVERY_BRANCH" --project-id "$NEON_PROJECT_ID" --database-name '<database-name>' --role-name '<owner-role>')
   load_libpq_env "$TARGET_URL"
   ```

   `--no-secrets` leaves the connection string out of the command output. The URL is captured into a shell
   variable and never printed. Omitting `--pooled` returns the direct URL, which the restore role uses.

2. **Older incident (encrypted copy).** A Neon branch inherits its parent's databases, so create a new database
   inside the new branch and use only that database. Verify it is empty (below) before any restore.

   ```sh
   RESTORE_BRANCH='restore-<incident-id>'
   RESTORE_DB='<new-database-name>'
   neon branches create --project-id "$NEON_PROJECT_ID" --name "$RESTORE_BRANCH" --no-secrets
   neon databases create --project-id "$NEON_PROJECT_ID" --branch "$RESTORE_BRANCH" --name "$RESTORE_DB" --owner-name '<owner-role>'
   TARGET_URL=$(neon connection-string "$RESTORE_BRANCH" --project-id "$NEON_PROJECT_ID" --database-name "$RESTORE_DB" --role-name '<owner-role>')
   load_libpq_env "$TARGET_URL"
   ```

3. **Neon unavailable.** Provision PostgreSQL 17 with a fresh empty database and TLS at another provider (the
   provider's own steps; not covered here). Enter its direct URL without echo:

   ```sh
   printf 'Direct URL of NEW empty database (not echoed): '
   read -rs TARGET_URL
   echo
   load_libpq_env "$TARGET_URL"
   ```

`load_libpq_env` stops with an error for a URL it cannot represent exactly (for example one with a TLS mode
other than the three listed or with an extra parameter). Stop and treat that as a blocker, not as a reason to
edit the URL by hand. `TARGET_URL` is kept only as a shell variable, for the Prisma check below. Remove it when
the procedure ends.

#### Container and key preparation

The age identity is created once, by the operator, on a trusted machine. Its private key is printed to the
terminal only; do not redirect the output and do not save it as a file. Record it directly in the password
manager and on paper, and give only the `age1...` public recipient to the backup configuration. Do not share
the private key, record the terminal, or use a newly generated key to decrypt an existing backup.

```sh
docker run --rm --log-driver none "$IMAGE" sh -c 'apk add --no-cache age >/dev/null && age-keygen'
```

`age-keygen` writes the private key to standard output and the `Public key:` line to standard error; both
appear on screen. `--log-driver none` keeps them out of the daemon log. The `sh -c` argument contains no single
quotes, so it can be copied as shown.

#### Empty-target check (encrypted copy, before any restore)

Run it against the database created above. Expected result: `(0 rows)`. Any row, or a failed connection, stops
the procedure. Independently confirm that the provider, project, branch and database are the intended new
target. The SQL goes in by a quoted heredoc, so `$` and quotes reach psql unchanged.

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

Set the placeholders in the private terminal. `BACKUP_DIR` must be an absolute path. The directory is mounted
read-only. `TARGET_URL` must be the new empty database from the previous step, never the production database.
The libpq variables come from it through `load_libpq_env` and reach the container by name only.

```sh
BACKUP_DIR='<absolute-directory-containing-encrypted-copy>'
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

Proceed only on `Restore exit: 0`. The identity is passed on stdin and is never written to a key file; no
plaintext dump is written by this procedure. `--dbname "$PGDATABASE"` is required: without an explicit
`--dbname`, `pg_restore` writes the SQL to standard output instead of restoring. `unset` does not erase shell
memory, so close the terminal afterwards. A restore that stops partway must be discarded and retried in another
fresh empty database; do not repair it in place.

`set -o pipefail` inside the container's `sh` requires a shell that supports it (the Alpine image's `sh` is
BusyBox); this is verified by the Docker acceptance run, not assumed here.

#### Verification queries

The three queries are the ones the verified backup uses (`scripts/backup/container/verify.sh`). Keep them
unchanged, so the same definitions decide every check.

```sh
IDENTITY_SQL="SELECT format('%I.%I', n.nspname, c.relname) || E'\t' || string_agg(format('%I %s %s', a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE 'NULL' END), ',' ORDER BY a.attnum)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
GROUP BY n.nspname, c.relname
ORDER BY 1;"
COUNTS_SQL="SELECT format('%I.%I', n.nspname, c.relname) || E'\t' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY 1;"
MIGRATION_SQL="SELECT migration_name FROM public._prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name DESC LIMIT 1;"
# The release's latest migration, from the release checkout (same ordering as migration_name DESC).
RELEASE_MIGRATION=$(ls -1 prisma/migrations | grep -v '^migration_lock.toml$' | LC_ALL=C sort | tail -1)
```

- `IDENTITY_SQL`: every user table and partitioned table in every user schema, with column names, types and
  nullability (a table with no columns is reported as missing).
- `COUNTS_SQL`: exact `count(*)` per table, keyed `schema.table`, tab-separated.
- `MIGRATION_SQL`: the latest applied Prisma migration, ordered by `migration_name` as the backup does.

#### Verify the encrypted copy (age oracle)

The verification record was written by the backup from the restored dump. It holds the migration and the exact
counts keyed `schema.table`, with a `verify` status. Restoring the same dump must reproduce them exactly. The
record keeps no column definitions; those were compared with production when the copy was made.

```sh
TARGET_COUNTS=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$COUNTS_SQL")
TARGET_MIGRATION=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$MIGRATION_SQL")
RECORD_MIGRATION=$(node -e 'process.stdout.write(require(process.argv[1]).migration)' "$RECORD")

# Empty output means a mismatch: a record that is not "ok" exits early, so the left side is empty.
diff \
  <(node -e 'const r = require(process.argv[1]); if (r.verify !== "ok") process.exit(3); for (const [t, n] of Object.entries(r.counts)) console.log(t + "\t" + n)' "$RECORD" | LC_ALL=C sort) \
  <(printf '%s\n' "$TARGET_COUNTS" | LC_ALL=C sort) && echo "counts: exact match"

printf 'migration: record=%s target=%s release=%s\n' "$RECORD_MIGRATION" "$TARGET_MIGRATION" "$RELEASE_MIGRATION"
```

Pass only when all of these hold:

- restore exit is `0`, and the record's `verify` is `ok` (`suspicious` means the backup flagged a large count
  drop; that is an operator decision, not a pass);
- the table list and every count equal the record exactly (a missing or extra table blocks the switch);
- `record`, `target` and `release` migration names are identical. If the restored migration is older than the
  release, or newer, stop and decide as an operator; do not run `migrate deploy` against restored data without
  that decision.

#### Verify the point-in-time branch (PITR oracle)

A branch has no verification record, so it is compared with **production's metadata read now**, through the
read-only source URL the backup uses (a role that only reads; the session is forced read-only). Writes after the
recovery point are absent from the branch by design, so counts are not compared exactly. They are checked for a
large drop against the latest verified copy, and the post-point query in the next section uses them.

```sh
# Read-only source: the backup's source URL, loaded in a subshell so no variable leaks into this shell.
PROD_READONLY_URL='<read-only production URL, the same role the backup uses>'
PROD_IDENTITY=$( load_libpq_env "$PROD_READONLY_URL" && export PGOPTIONS='-c default_transaction_read_only=on' && pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" )
PROD_MIGRATION=$( load_libpq_env "$PROD_READONLY_URL" && export PGOPTIONS='-c default_transaction_read_only=on' && pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$MIGRATION_SQL" )

load_libpq_env "$TARGET_URL"
TARGET_IDENTITY=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL")
TARGET_MIGRATION=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$MIGRATION_SQL")
TARGET_COUNTS=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$COUNTS_SQL")

[ -n "$PROD_IDENTITY" ] && [ "$PROD_IDENTITY" = "$TARGET_IDENTITY" ] && echo "schema: same as production now"
printf 'migration: production=%s target=%s release=%s\n' "$PROD_MIGRATION" "$TARGET_MIGRATION" "$RELEASE_MIGRATION"

# Large drops against the latest verified copy (same rule as the backup: below 80% of the earlier count).
# RECORD must point at the latest verified copy's record: set in the restore step for an encrypted copy, or
# set it here, as an absolute path, when only a point-in-time branch is being verified.
TARGET_COUNTS="$TARGET_COUNTS" node -e '
const before = require(process.env.RECORD).counts;
const after = Object.fromEntries(process.env.TARGET_COUNTS.trim().split("\n").map((line) => line.split("\t")));
const drops = Object.keys(before).filter((t) => before[t] > 0 && Number(after[t] ?? 0) * 100 < before[t] * 80);
console.log(drops.length ? "drops: " + drops.join(", ") : "drops: none");
'
```

Pass only when all of these hold:

- the identity of the branch equals production's identity read now (`same as production now`). A difference
  means a schema change happened after the recovery point: stop and decide;
- `production`, `target` and `release` migration names are identical. Otherwise stop and decide;
- no drops are reported, or each drop is explained and approved by the operator.

Then confirm the Prisma view, using the release checkout with dependencies installed. `prisma.config.ts`
reads `DATABASE_URL` and falls back to a localhost URL when it is unset, so the variable must be set explicitly:

```sh
DATABASE_URL="$TARGET_URL" npx prisma migrate status
```

Investigate any mismatch or nonzero status before switching. Inspect representative users, lists and products
without exposing personal data, and test sign-in and reading a test list against the target in an isolated
preview. Do not seed restored data.

#### Write barrier and reconciliation

The switch loses every write made to production after the recovery point, unless it is reconciled. Nothing here
may be skipped: a green smoke test does not show that post-point changes were kept.

1. **Baseline, before stopping writes.** Run the statements below through the read-only production subshell
   shown in _Verify the point-in-time branch_ (`( load_libpq_env "$PROD_READONLY_URL" && export PGOPTIONS=... && pg_run -i ... )`).
   Record the write counter and the counts in the incident ticket as `WRITE_BASELINE` and `PRE_STOP_COUNTS`. They
   are the old database's state for the rollback check.

   ```sql
   SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) AS write_counter FROM pg_stat_user_tables;
   ```

   Also run `COUNTS_SQL`.

2. **Stop every writer.** The barrier is at the database, so it also stops writers that are not in the app
   (old deployments, scripts with the owner role). Before revoking, save the runtime role's privileges (grants
   only, no secrets) in the ticket: they are the exact list to restore on rollback.

   ```sql
   SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind, a.privilege_type
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   JOIN pg_roles r ON r.oid = a.grantee
   WHERE r.rolname = '<runtime-role>' AND n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
   ORDER BY 1, 2, 4;

   REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM <runtime-role>;
   ```

   The grant list is read from `pg_class` ACLs, which every role can read. The `information_schema` grant views
   show only privileges the current role granted or received, so the read-only role would see an empty list.

   Run the `REVOKE` as the owner role, record the time as `WRITE_STOP_AT`, and stop every operator script or
   migration that holds the owner role. Stop any writer that does not use the runtime role by the operator's
   method, and record which one.

3. **Verify the barrier.** Repeat at least two minutes apart; both must hold:

   - no other client session is active (`state <> 'idle'`), except the operator's own. Run it as a role that
     can read other sessions (superuser or `pg_read_all_stats`); a role that cannot sees only its own sessions,
     and an empty result then proves nothing:

     ```sql
     SELECT usename, application_name, client_addr, state, backend_start
     FROM pg_stat_activity
     WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid() AND state <> 'idle';
     ```

   - the write counter equals `WRITE_BASELINE` (the statistics can lag briefly; a counter that is stable over
     two minutes is the evidence, not one read);
   - the runtime role has no table write privilege left. This query returns `0`:

     ```sql
     SELECT count(*)
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(c.relacl) AS a
     JOIN pg_roles r ON r.oid = a.grantee
     WHERE r.rolname = '<runtime-role>' AND n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
     ```

4. **Post-point changes** (read-only production, after the barrier). Tables with Prisma timestamps (`createdAt`
   or `updatedAt`) report rows created or changed after the recovery point. The generator builds one count query per
   such table and `\gexec` runs them in the same session. The output lines are `table|changed_rows`:

   ```sh
   export POINT='<RECOVERY_POINT, RFC 3339, e.g. 2026-11-24T10:00:00Z>'
   (
     load_libpq_env "$PROD_READONLY_URL" && export PGOPTIONS='-c default_transaction_read_only=on' &&
     pg_run -i -e POINT "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -v point="$POINT" -f -' <<'SQL'
   SELECT format(
     'SELECT %L AS table_name, count(*) AS changed_rows FROM %I.%I WHERE %s',
     n.nspname || '.' || c.relname, n.nspname, c.relname,
     string_agg(format('%I > %L', a.attname, :'point'), ' OR ' ORDER BY a.attname)
   )
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relkind = 'r' AND n.nspname = 'public' AND a.attname IN ('createdAt', 'updatedAt')
   GROUP BY n.nspname, c.relname
   ORDER BY c.relname \gexec
   SQL
   )
   ```

   Limits to state in the ticket: deleted rows and changes made by raw SQL that do not touch `updatedAt` are
   **not** visible here. `updatedAt` is set by the Prisma client, not by the database.

5. **Decision, written in the ticket before any switch.** One of:

   - **Reconcile**: export the rows reported above (read-only, to the operator's encrypted private storage,
     never GitHub), review them, and apply them to the target as the owner role. Then repeat the age or PITR
     checks and the runtime checks; or
   - **Accept loss**: explicit written approval that names the `changed_rows` totals, `WRITE_STOP_AT`, and the
     limits above.

   Without one of these, do not switch. This is a question for the operator, not a default.

#### Runtime role on the target (before the switch)

The site must reach the target as the runtime role, never as the restore role. The runtime role is created on
the target by the operator, with the provider's own method, and its password is set without echo. It must
match production's privileges:

```sh
# Run the same query (the grant list from the barrier step) on production through the read-only session and on
# the target through the owner role: the two outputs must be identical. Tables, partitions and sequences are covered.
SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind, a.privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
JOIN pg_roles r ON r.oid = a.grantee
WHERE r.rolname = '<runtime-role>' AND n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
ORDER BY 1, 2, 4;
```

Then build the runtime URL and check it reaches the target as the runtime role:

```sh
CUTOVER_URL=$(neon connection-string "$RESTORE_BRANCH" --project-id "$NEON_PROJECT_ID" --database-name "$RESTORE_DB" --role-name '<runtime-role>' --pooled)
# (For the point-in-time branch use "$RECOVERY_BRANCH" and its database instead.)
load_libpq_env "$CUTOVER_URL"
pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<'SQL'
SELECT current_database(), current_user, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public
FROM pg_roles WHERE rolname = current_user;
SQL
```

Expected: `<database>|<runtime-role>|f|f|f|f|f`. Anything else stops the switch. The runtime role must not own
any table in `public` (`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user;`
returns no rows).

#### Vercel production-only setting

- In the Vercel dashboard (Project Settings → Environment Variables), confirm that the existing `DATABASE_URL`
  entry is scoped to **Production only**. If it also covers Preview or Development, stop: updating the entry
  changes every environment that it covers. Split the entry in the dashboard first; that is an operator action.
- Run the CLI from the linked release checkout and confirm `.vercel/project.json` names the Clickmoji production
  project.

#### Switch (real incident only, after every check and decision above)

1. The write barrier is in place, `WRITE_STOP_AT` is recorded, and the post-point decision is written.
2. Store the current production `DATABASE_URL` value in the password manager (the value, not in a file or a
   ticket), so the old target can be restored in one step if the switch fails. Keep the saved grant list from
   the barrier step in the ticket.
3. Update the existing Vercel production variable from the linked release checkout. The value comes from stdin,
   never from argv. Check the project and keep writes stopped if the update or deployment fails.

   ```sh
   printf '%s' "$CUTOVER_URL" | vercel env update DATABASE_URL production --yes &&
     vercel deploy --prod
   ```

   In the Vercel dashboard, edit the existing Production variable under Project Settings → Environment Variables,
   then redeploy. Do not add a Preview or Development entry.

4. Record the write counter of the target right after the deployment (`TARGET_BASELINE`). It is the rollback
   reference.
5. Verify the deployed site: sign-in, reading a test list, and the runtime error view in Vercel. Only then resume
   writes. Writes now go to the target, which already has the runtime role's grants from the check above. The old
   database stays barrier-protected and receives no writes after the switch.
6. Record the selected backup or time, the target name (not its URL), the checks that passed, the decision used,
   `WRITE_STOP_AT` and the switch time, without credentials.

#### Rollback

- **Before any write reaches the target.** Check that the target's write counter still equals `TARGET_BASELINE`.
  Then put the saved URL back in the Production variable, redeploy, and restore the old runtime role's grants
  from the saved list. Before lifting the old database's barrier, check that it is unchanged since the barrier:
  `COUNTS_SQL` equals `PRE_STOP_COUNTS` and the write counter equals `WRITE_BASELINE`. A difference means a writer
  got past the barrier: stop and decide.
- **After any write reached the target.** There is no blind rollback. Writes made on the target must first be
  reconciled into the old database through the same decision as above. Rolling back without that loses them.
- Do not mark or delete the old target while a rollback is still possible.

If any step fails, keep the old setting: update the variable with the value saved in step 2 and redeploy, then
investigate. Finally unset the variables and remove temporary targets and files when they are no longer needed:

```sh
unset TARGET_URL CUTOVER_URL PROD_READONLY_URL POINT RECOVERY_TIME RESTORE_DB AGE_IDENTITY
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGCHANNELBINDING PGOPTIONS
```

Retain the selected encrypted backup according to policy.

#### Recovery drill and cutover dry run

Quarterly and before the first users, use the latest verified encrypted copy and the commands above (_Create the
target_ step 2, empty-target check, restore, _Verify the encrypted copy_, and the runtime-role check) against a
fresh empty disposable database. Record the outcome and delete the disposable database. Never change site settings
during a drill.

Before the first real switch, run the cutover dry run on a disposable target with a synthetic production copy: the
baseline, barrier, post-point query, runtime checks and rollback check, stopping before `vercel env update`.

For a synthetic drill, encrypt a known custom-format test dump to the same recipient and write a verification
record with the same fields (`verify`, `migration`, `counts` keyed `schema.table`) and run the same checks. The
expected outcomes are: an exact match passes; a record whose counts differ from the restored data fails the age
check; and a point-in-time comparison against a copy with a different schema fails the schema check. The
Clickmoji migration and application checks apply only to an actual Clickmoji copy.

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
