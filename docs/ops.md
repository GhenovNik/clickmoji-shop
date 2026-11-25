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
- Production backups must be access-controlled, monitored, and restore-tested; encryption with `age` is enabled explicitly for production (`BACKUP_ENCRYPT=1`), while development runs unencrypted by default (`BACKUP_ENCRYPT=0`, explicit B35 exception for protected `backups/`).
- Do not store production database copies in GitHub in any form: not as Actions artifacts (short-term ones included), releases, caches or repository files, even encrypted. The earlier allowance for short-term ordinary artifacts is withdrawn; GitHub takes no part in copying. Existing production copies there are removed under task A, not kept as a fallback.
- Before a production migration, create and verify a fresh backup, run `prisma migrate deploy` with
  a direct/unpooled database URL, and confirm `prisma migrate status` afterwards.

### Verified production backups and retention (AGE-1669)

Verified production backups run via `npm run db:backup:verified` (`node scripts/backup/cli.mjs`) inside pinned PostgreSQL 17 containers.

- **What automated verification proves (and does not prove):**
  - Every run dumps the source database (`pg_dump --format=custom`), restores that plaintext `dump.custom` into a disposable PostgreSQL 17 cluster, and verifies schema identities, applied Prisma migration, and row counts (`verifyScope: "plaintext"` in `meta/<copy>.json`).
  - Each published copy records `sizeBytes` and `sha256` in `meta/<copy>.json`. Before taking, confirming, or pruning any backup, the script verifies the exact byte size and `sha256` of existing accepted copies; any truncation, same-size byte substitution, or legacy record lacking a recorded digest (which is never auto-promoted by re-hashing) fails closed and preserves all existing copies intact.
  - When `BACKUP_ENCRYPT=1`, the script snapshots the validated public key from `BACKUP_AGE_RECIPIENT_FILE` into the temporary run directory outside any repository, encrypts `dump.custom` with `age` using that exact snapshot, stamps the same snapshot's `recipientSha256`, and verifies non-empty ciphertext output before atomic publication.
  - Automated runs hold **no private key** and therefore **do not prove decryption** of `.dump.age` with the operator's `age` identity. Proving `.dump.age` decryption and restore requires an explicit operator restore test and confirmation (binding the exact ciphertext `sha256` from the restored snapshot) before old unencrypted `.dump` copies are deleted or saved encrypted copies are rotated.

- **Destination and Git guard (`BACKUP_DIR`):**
  - Store copies in `backups/` of the **main repository checkout** on the Mac mini (for example, `~/Projects/clickmoji-shop/backups/`), which is gitignored via `/backups/` in `.gitignore`.
  - `BACKUP_DIR` **must** be explicitly configured as an **absolute path** to that main checkout's `backups/` directory (no default; relative or missing `BACKUP_DIR` fails even when run outside any repository or from a worktree). This prevents runs from temporary worktrees or other checkouts from creating a separate backup history.
  - Before creating or writing anything—and again immediately before atomic publication—the script resolves the physical path of `BACKUP_DIR` and runs `git check-ignore` in the destination repository regardless of the caller's working directory (covering dump files, `.partial-*` temporaries, `meta/*.json`, and confirmation state). If Git is unavailable or any physical path inside a repository is not ignored, the script fails with a status reason and writes nothing.
  - The directory is maintained at mode `0700`, and both temporary `.partial-*` files and final published copies are created with mode `0600` from creation.
  - Intermediate plaintext dumps (`dump.custom`) and temporary PostgreSQL 17 clusters exist only inside a private temporary directory outside any repository (`TMPDIR` / `os.tmpdir()`) and are deleted on completion, failure, and interruption. Storing a verified unencrypted `clickmoji-<UTC>.dump` inside protected `backups/` when `BACKUP_ENCRYPT` is off is an explicit operator exception (B35).
  - Published files are written under a `.partial-*` temporary name and atomically renamed after full write and `fsync`, prior to pruning. An interrupted write is never counted as a completed copy.
  - **Warning:** Never run `git clean -x` (or `git clean -fdx`) in the main checkout and never delete `backups/`, or all retained copies and their `meta/` records will be lost.

- **Settings, modes, and step-by-step cutover to production:**
  - Three explicit settings govern retention, schedule interval, and encryption (scheduler/launchd configuration stays in task Г):
    1. `BACKUP_RETENTION_COUNT`: number of newest successful copies to keep across `.dump` and `.dump.age` formats (integer >= 1, default `2`; no weekly or monthly tiers).
    2. Job interval (configured in the scheduler): determines how often backups run.
    3. `BACKUP_ENCRYPT`: `0`/unset (default, unencrypted `clickmoji-<UTC>.dump`, `BACKUP_AGE_RECIPIENT_FILE` not required) or `1` (explicit `age` encryption to `clickmoji-<UTC>.dump.age`, requiring `BACKUP_AGE_RECIPIENT_FILE`; missing/invalid key when enabled fails early with a status reason).
  - **Development (current):** `BACKUP_ENCRYPT=0` (default), `BACKUP_RETENTION_COUNT=2`, scheduled once every **3 days**. With successful runs, the 2 retained copies cover roughly **3–6 days** back.
  - **Production (at first users):** switch to **daily** interval, `BACKUP_ENCRYPT=1` (with `BACKUP_AGE_RECIPIENT_FILE`), and **more than 2** retained copies; the exact copy count `N` is determined by the operator at cutover (not predetermined; no fixed production number is hard-coded here). Switching changes only those settings—no code changes.
  - **Step-by-step cutover from unencrypted mode to encrypted production:**
    1. **Enable production settings:** set daily scheduler interval (task Г), `BACKUP_ENCRYPT=1`, `BACKUP_AGE_RECIPIENT_FILE` pointing to the public `age1...` recipient file, and `BACKUP_RETENTION_COUNT` to the operator-chosen production `N`.
    2. **Run the first encrypted backup (no plaintext deletion yet):**

       ```sh
       npm run db:backup:verified
       ```

       - Existing accepted unencrypted `.dump` copies are **not** deleted by normal pruning while waiting for confirmation. If `BACKUP_RETENTION_COUNT` is smaller than the number of existing accepted unencrypted `.dump` copies (for example `N=1` with 2 existing `.dump` copies), the backup run refuses early before publication with a reason instructing you to raise `BACKUP_RETENTION_COUNT` for the transition period (meanwhile, `--confirm-encrypted-restore` remains available if a `.dump.age` copy already exists).
       - **Temporary limit exception:** with `plainKept` unencrypted `.dump` copies (`<= N`), the **first** `.dump.age` copy of the current transition is preserved for operator verification, and any other `.dump.age` copies may fill only free slots inside the normal limit `N`. Total retained copies are therefore capped at `max(N, plainKept + 1)` (at most `N + 1` when unencrypted copies fill `N`, never `N + 2`).
       - If unencrypted copies and the first `.dump.age` copy already fill that cap and further unconfirmed runs execute, each run still dumps, verifies restore, and checks encryption, does not keep the newly produced `.dump.age`, preserves the existing `.dump` copies and first `.dump.age` copy (leaving the comparison baseline on the surviving copy), and reports `verify=ok decrypt=unconfirmed kept=<first .dump.age> new=pruned` without claiming the pruned copy was saved.
       - If starting directly with `BACKUP_ENCRYPT=1` and **no initial unencrypted copies**, runs up to `N` succeed with `decrypt=unconfirmed`, and any run that would evict an unconfirmed copy refuses early until the operator confirms decryption of a saved `.dump.age` copy (or raises `BACKUP_RETENTION_COUNT`).
       - The status line and CLI output carry the reminder:
         `decrypt=unconfirmed (шифрование включено, открытые копии ждут подтверждения восстановления)` (or `первая копия ждёт подтверждения восстановления` when no unencrypted copies exist).

    3. **Decrypt and restore the first `.dump.age` copy from a protected local snapshot into a separate empty PostgreSQL 17 database (never production):**

       ```sh
       # Set BACKUP_FILE to the first clickmoji-<UTC>.dump.age name and PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGSSLMODE
       # to the disposable test target, and enter AGE_IDENTITY without shell echo.
       # Copy to a private 0700/0600 local snapshot outside the repository so the SHA-256 hash and
       # age -d read the exact same ciphertext bytes:
       unset RESTORED_SHA256
       if RESTORED_SHA256=$(
         SNAP_DIR=$(umask 077 && mktemp -d) || exit 1
         trap 'rm -rf "$SNAP_DIR"' EXIT
         cp "$BACKUP_DIR/$BACKUP_FILE" "$SNAP_DIR/$BACKUP_FILE" || exit 1
         chmod 600 "$SNAP_DIR/$BACKUP_FILE" || exit 1
         checksum=$(shasum -a 256 "$SNAP_DIR/$BACKUP_FILE") || exit 1
         printf '%s\n' "$AGE_IDENTITY" | pg_run -i -v "$SNAP_DIR:/snap:ro" -e BACKUP_FILE "$IMAGE" sh -c '
           set -eu
           set -o pipefail
           apk add --no-cache age >/dev/null
           age -d -i /dev/stdin "/snap/$BACKUP_FILE" | pg_restore --no-owner --no-privileges --exit-on-error --dbname "$PGDATABASE"
         ' >&2 || exit 1
         printf '%s\n' "${checksum%% *}"
       ); then
         printf '%s\n' 'Restore succeeded. Inspect the restored tables before confirming.'
       else
         unset RESTORED_SHA256
         printf '%s\n' 'Restore failed. Stop here and repeat the restore before confirming.' >&2
         false
       fi
       ```

       Confirm the restored tables and data in that separate test database before proceeding.

    4. **Record explicit operator confirmation with the snapshot SHA-256 (connects to no DB, requires no private key, deletes nothing):**

       ```sh
       npm run db:backup:verified -- --confirm-encrypted-restore "$BACKUP_FILE" --sha256 "${RESTORED_SHA256:?Complete the restore successfully before confirming}"
       ```

       (or `node scripts/backup/cli.mjs --confirm-encrypted-restore "$BACKUP_FILE" --sha256 "$RESTORED_SHA256"` with `BACKUP_DIR` and `BACKUP_STATUS_FILE` set). Under the shared `.backup.lock` and Git guard, this verifies that the on-disk `.dump.age` and its `meta/<copy>.json` still match `"$RESTORED_SHA256"` and records the confirmation into `backups/meta/.encrypted-restore-confirmed.json` (`0600`) as well as the durable confirmed public-key policy in `backups/meta/.confirmed-recipient.json` (`0600`). Missing, incomplete, foreign, corrupted/substituted, digest-mismatched, or stale files (older than a newer `.dump`) are rejected without deleting anything.

    5. **Run the next successful encrypted backup to complete the cutover:**

       ```sh
       npm run db:backup:verified
       ```

       Only **after** the new `.dump.age` copy is verified and atomically published does the script verify the confirmed ciphertext fingerprint, automatically purge unencrypted `.dump` copies, return to the unified retention limit `N` across encrypted copies, and clear the consumed transition state `.encrypted-restore-confirmed.json`. The durable recipient policy `.confirmed-recipient.json` remains in place across cutover, restarts, and temporary switches to `BACKUP_ENCRYPT=0`: any subsequent `BACKUP_ENCRYPT=1` run (or `--confirm-encrypted-restore`) with a different public key in `BACKUP_AGE_RECIPIENT_FILE` fails closed before dump, publication, or pruning (key rotation is outside Г0). On this cutover run that removes unencrypted copies, the **operator-confirmed** `.dump.age` copy is guaranteed to stay among the `N` retained copies (including `N = 1`, where the confirmed copy takes priority on that cutover run over the newly published unconfirmed ciphertext and the status/CLI report `kept=<confirmed .dump.age> new=pruned`; subsequent runs after unencrypted copies are gone apply standard `N`-copy retention). Excess unconfirmed encrypted copies are pruned before unencrypted copies (oldest-to-newest), and confirmation state is cleared only after unencrypted copies are removed, so no interruption point during cleanup destroys an available verified copy. If that run fails before full publication (or is rejected by the row-drop guard), existing unencrypted `.dump` copies and the confirmation state remain intact.

  - **Freshness threshold:** Computed as **interval + 1 day** (no separate threshold setting): `4 days` in development (`3 days + 1 day`), `2 days` once switched to daily production (`1 day + 1 day`).

- **Row-count drop guard (>20%) and single-run confirmation:**
  - Each verified restore compares exact row counts per table against the **latest accepted copy of any age** (even if that previous accepted copy is older than 2 days).
  - A drop greater than **20%** on any table rejects the new copy, preserves all existing copies intact, and writes the failure reason to `BACKUP_STATUS_FILE`.
  - Legitimate bulk deletions (such as cleaning test data) can trigger this guard. Once you confirm the deletion is intentional, run **one explicit single-run confirmation** with the standard CLI flag:

    ```sh
    npm run db:backup:verified -- --allow-row-drop
    ```

    (or `node scripts/backup/cli.mjs --allow-row-drop` with the same environment variables). Do not put `--allow-row-drop` in scheduled jobs. It still runs the full dump, temporary PostgreSQL 17 restore, schema identity, and migration checks, publishes the copy with `verify=ok`, and updates the comparison baseline for subsequent runs.

- **Choosing between retained copies and Neon PITR:**
  - Always check the actual `createdAt` timestamps in `meta/<copy>.json` against the time of corruption or bad migration.
  - Restore from a retained backup whenever a **usable copy taken before the error** still exists (roughly 3–6 days back at 2 copies / every 3 days; in a daily 2-copy cycle, corruption noticed after 2 days has no pre-error copy).
  - When no usable pre-error copy exists, the only recovery option is **Neon point-in-time recovery (PITR)** within the Neon plan's restore window.
  - **Confirmed Neon PITR restore window:** `<TBD: confirm Neon plan PITR restore window in task Г>`

- **Direct restore commands (into a fresh empty PostgreSQL 17 target, never production):**
  - Unencrypted verified copy (`clickmoji-<UTC>.dump`):

    ```sh
    pg_run -v "$BACKUP_DIR:/backup:ro" -e BACKUP_FILE "$IMAGE" sh -c '
      pg_restore --no-owner --no-privileges --exit-on-error --dbname "$PGDATABASE" "/backup/$BACKUP_FILE"
    '
    ```

  - Encrypted copy (`clickmoji-<UTC>.dump.age`):

    ```sh
    printf '%s\n' "$AGE_IDENTITY" | pg_run -i -v "$BACKUP_DIR:/backup:ro" -e BACKUP_FILE "$IMAGE" sh -c '
      set -eu
      set -o pipefail
      apk add --no-cache age >/dev/null
      age -d -i /dev/stdin "/backup/$BACKUP_FILE" | pg_restore --no-owner --no-privileges --exit-on-error --dbname "$PGDATABASE"
    '
    ```

### Включение копий на Mac mini

Задание launchd запускает `scripts/backup/run-scheduled.sh` каждые 3 дня (интервал задаётся настройкой). Скрипт берёт адрес роли только на чтение из связки ключей macOS и запускает `npm run db:backup:verified` с `BACKUP_DIR` основной копии `~/Projects/clickmoji-shop/backups/`, без шифрования (`BACKUP_ENCRYPT=0`) и с двумя последними удачными копиями (`BACKUP_RETENTION_COUNT=2`). Адрес передаётся только в окружение этого одного процесса `npm`: не в argv, не в файл, не в журнал.

- **Предварительно на Mac mini:** Docker Desktop запущен в пользовательской сессии; `node` и `npm` доступны в `PATH` при установке; основная копия лежит в `~/Projects/clickmoji-shop`, и её `backups/` игнорируется git. Ничего не устанавливается и не скачивается.

#### Действия оператора (два, однократно)

1. **Роль только на чтение в Neon, SQL-командами.** Выполняет владелец базы в SQL-редакторе Neon; повышенная роль Neon не нужна. Пароль создаётся в менеджере паролей и вставляется в редактор вместо `<пароль>`. Ни адрес, ни пароль в чат, задачи или файлы не передаются.

   ```sql
   CREATE ROLE clickmoji_backup_ro LOGIN PASSWORD '<пароль>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   GRANT CONNECT ON DATABASE <имя базы> TO clickmoji_backup_ro;
   GRANT USAGE ON SCHEMA public TO clickmoji_backup_ro;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO clickmoji_backup_ro;
   GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO clickmoji_backup_ro;
   -- Таблицы, которые появятся позже миграциями, получают право на чтение от роли, создающей их.
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO clickmoji_backup_ro;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO clickmoji_backup_ro;
   ```

   Вместо явных `GRANT SELECT` можно выдать `GRANT pg_read_all_data TO clickmoji_backup_ro;`, если владелец имеет на это право. Явные выдачи предпочтительнее: они видны в каталоге.

   **Проверка отсутствия записи** (от владельца, только системный каталог; данные не читаются и не меняются, записью пробовать нельзя даже с откатом):

   ```sql
   -- Ноль строк: нет права записи ни на таблицу, ни на последовательность, в том числе через PUBLIC и членство в ролях.
   SELECT n.nspname, c.relname, c.relkind
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND (
       (c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
         has_table_privilege('clickmoji_backup_ro', c.oid, 'INSERT')
         OR has_table_privilege('clickmoji_backup_ro', c.oid, 'UPDATE')
         OR has_table_privilege('clickmoji_backup_ro', c.oid, 'DELETE')
         OR has_table_privilege('clickmoji_backup_ro', c.oid, 'TRUNCATE')
         OR has_table_privilege('clickmoji_backup_ro', c.oid, 'REFERENCES')
         OR has_table_privilege('clickmoji_backup_ro', c.oid, 'TRIGGER')))
       OR (c.relkind = 'S' AND has_sequence_privilege('clickmoji_backup_ro', c.oid, 'UPDATE'))
     );
   -- Ноль строк: нет права создавать объекты в схемах базы.
   SELECT nspname FROM pg_namespace WHERE has_schema_privilege('clickmoji_backup_ro', oid, 'CREATE');
   -- Ноль строк: роль без признаков администратора.
   SELECT rolname FROM pg_roles
   WHERE rolname = 'clickmoji_backup_ro'
     AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication);
   ```

   Каждый запрос должен вернуть ноль строк. Если хотя бы один вернул строку, роль не готова: отозвать лишнее (`REVOKE`) и повторить проверку.

2. **Адрес в связку ключей Mac mini.** Команда запрашивает значение интерактивно (`-w` без значения, см. `man security`). В терминале Mac mini вставьте полный прямой адрес роли вида `postgres://clickmoji_backup_ro:…@…/…?sslmode=require` (прямой, не через пулер) и нажмите Enter:

   ```sh
   security add-generic-password -s clickmoji-backup-readonly -a clickmoji -w
   ```

   Если элемент уже есть, `security` сообщит об этом. Тогда сначала удалите его: `security delete-generic-password -s clickmoji-backup-readonly -a clickmoji`, и повторите команду. Адрес не набирается в командной строке, поэтому не попадает в историю shell.

   Команда `add-generic-password` пишет в связку по умолчанию, а сценарий читает только из связки входа `~/Library/Keychains/login.keychain-db` (явный путь, без поиска по всем связкам). Поэтому до добавления проверьте, что связка по умолчанию — связка входа: `security default-keychain` должна показать `…/Library/Keychains/login.keychain-db`. Если это не так, сделайте связку входа связкой по умолчанию в Keychain Access (правый клик по связке «login» → «Сделать связкой по умолчанию») и только после этого выполните добавление. Не передавайте путь к связке как аргумент `-w`: этот флаг принимает значение пароля.

   Проверка после добавления (значение не выводится, нужен только код возврата):

   ```sh
   security find-generic-password -s clickmoji-backup-readonly -a clickmoji "$HOME/Library/Keychains/login.keychain-db" >/dev/null && echo найдено
   ```

   Выведено «найдено» — элемент на месте. Сценарий не ищет запасной вариант: если найден только элемент в другой связке или с другим счётом, запуск завершится со статусом `сбой: нет роли только на чтение в связке ключей`.

#### Установка и удаление (куратор)

- **Первая копия вручную**, до установки задания, из основной копии: `bash scripts/backup/run-scheduled.sh`. Если macOS запросит доступ, разрешите его для `/usr/bin/security` к этой записи на постоянной основе, чтобы плановый запуск мог прочитать её без диалога. Итог записан в статус-файл (см. ниже).
- **Установка:** `bash scripts/backup/launchd/install.sh` из `~/Projects/clickmoji-shop`. Интервал по умолчанию 259200 секунд (3 дня); другой задаётся `CLICKMOJI_BACKUP_INTERVAL_SECONDS` (целое число, не меньше 60). Повторный запуск заменяет агент, не создавая второго. Агент `com.clickmoji.db-backup` не запускается сразу (`RunAtLoad` выключен), первый запуск по интервалу.
- **Удаление:** `bash scripts/backup/launchd/uninstall.sh`. Удаляет агент и его plist; статус-файл, журнал и копии не трогает. Повторный запуск безопасен.
- **Статус-файл:** `~/Library/Logs/clickmoji-backup/status.tsv`, по одной строке на запуск, три поля через табуляцию: `<время UTC с миллисекундами>\t<ok|failed>\t<текст>`. Удачный запуск: `…\tok\tsize=<байты> verify=ok file=clickmoji-<UTC>.dump prune=<результат>`. Неудачный: `…\tfailed\tсбой: <причина>`; при отсутствии роли в связке: `…\tfailed\tсбой: нет роли только на чтение в связке ключей`. Для контроля давности пульт читает дату последней строки с `ok`. При интервале 3 дня порог составляет 4 суток. Адреса, пароли и данные в файле не попадают.
- **Журнал launchd:** `~/Library/Logs/clickmoji-backup/launchd.log` (вывод `npm`; адрес базы в нём не появляется).
- **Копии:** `~/Projects/clickmoji-shop/backups/`, каталог и файлы доступны только владельцу. Не выполнять `git clean -x` в основной копии.
- **Глубина восстановления Neon (PITR):** `<TBD: confirm Neon plan PITR restore window in task Г>`. Тариф Neon не подтверждён: ВОПРОС: тариф Neon. Значение записывается сюда после подтверждения; до тех пор его не угадываем.

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
- **Write barrier**: a database-side closing of the site's writes, on production and on the target, by revoking the
  runtime role's write privileges. It is an addition to the fence, not a replacement for it, and it is the only stop that
  holds whichever Vercel deployment serves the domain (see _Write barrier_).
- **Frozen production**: production after the fence is verified. Its data no longer changes, so a comparison against
  it is complete, including deletes. `FROZEN_AT` is the time of the last passing fence check.
- **Writers**: every process or person that can change production data: the production Vercel deployments of `master`
  and any older deployment still serving requests or running background work (including scheduled functions);
  operator scripts with a write command (`scripts/catalog-cleanup.ts`, `scripts/emoji-import.ts --apply`, the write
  commands of `scripts/db-*.ts` and `scripts/db-transfer.ts`); the GitHub workflow `Production migration`
  (`migrate-production.yml`) and any `prisma migrate deploy` run; database-side jobs (`pg_cron`, if installed); and
  any other client that holds a production URL or a role with write privileges. Preview deployments never hold a
  production URL. A scheduled backup job only reads; none is scheduled on master since #159 removed
  `.github/workflows/db-backup.yml` (commit 7b1076e08). Any backup job that is active is paused for the window (_Fence
  production_, step 1), so that the session check sees no unidentified connection.
- **Owner role** (`<owner-role>`): owns the restored target. Used for restore, verification and the grant checks. It
  is never the site's `DATABASE_URL`.
- **Runtime role** (`<runtime-role>`): the role in the site's production `DATABASE_URL`. It is not an owner, not a
  superuser, has no `CREATEROLE`, `CREATEDB` or `BYPASSRLS`, owns no object, and cannot create objects in `public`.

#### Shell and prerequisites

- Commands are written for **zsh or bash**. Hidden input uses `printf` followed by `read -rs NAME`, which works in
  both; do not use the zsh-only `read -rs 'NAME?prompt'` form.
- Needed: Docker running on the operator machine; Node.js 24; and a clean checkout of the compatible release (see
  _Write the expectations_). Nothing is installed on the host by these steps; `age` and PostgreSQL clients run inside
  the disposable containers.
- The Neon CLI (`neon`, version 4.9.0 or newer, `neon --version`), authenticated by the operator, is needed only for
  the Neon steps: point-in-time branches, Neon encrypted-copy branches and the Neon cutover URL. Restoring and verifying
  an encrypted copy into a PostgreSQL 17 target at another provider needs no Neon CLI, no Neon account and no reachable
  old source.
- The Neon flags in this section were written against the CLI reference. Before each run, check them with
  `neon branches create --help` and `neon connection-string --help` on the operator's
  version, and stop if a flag is missing.
- Use the same PostgreSQL image digest as the one below for every container.
- Every `docker run` below passes `--log-driver none`. Without it the daemon keeps container stdout and stderr,
  including the printed age identity, in its own log outside this terminal.
- Connection values never appear in argv. Containers receive `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
  `PGSSLMODE`, `PGCHANNELBINDING`, `PGOPTIONS` and `PGAPPNAME` **by name** (`-e NAME`), with values from this shell's
  environment.
  The only connection-related argument is the database name in `pg_restore --dbname "$PGDATABASE"`, which is not a
  secret.
- **Password boundary.** libpq reads `PGPASSWORD` from the environment, as its documentation describes. This procedure
  keeps it out of argv, out of the Docker daemon log (`--log-driver none`) and out of every file. It does not keep it
  out of the environment: the value is visible to processes of the same user, and while a container runs, to anyone
  who can inspect that container (`docker inspect` shows its environment) or who has access to the Docker daemon. The
  trust boundary is therefore the operator's own terminal and Docker host, not the command line.
- Connection URLs are entered with a hidden prompt or captured from a command's output into a shell variable. They are
  never typed into a command, a file, a log or a ticket.
- Work only in a private terminal: no shell tracing (`set -x`), no session recording, no shared screens.

```sh
IMAGE='postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'
NEON_PROJECT_ID='<neon-project-id>'
PROD_BRANCH='<production-branch-name>'   # the project's default branch; confirmed in _Create the target_

# Run start: one RUN_ID for this recovery attempt. Every private directory this attempt creates carries it in its marker,
# and cleanup removes only directories whose marker holds it. The scratch paths are reset here, so a path left in this
# shell by an earlier attempt (for example a point-in-time directory) is never removed by this attempt. Run this block
# once per attempt, before the first directory block below.
RUN_ID=$(openssl rand -hex 16)
EXP_DIR=''
RECOVERY_DIR=''
DIFF_DIR=''

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

# Shell mode for every command below: a failing stage of a pipeline is the pipeline's status and is never hidden.
set -o pipefail

# psql_stdin: SQL arrives on stdin; ON_ERROR_STOP makes a failed or interrupted read exit nonzero.
psql_stdin() { pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -'; }

# checked_read FILE COMMAND [ARG...]: runs COMMAND (SQL on stdin) and stores its output in FILE. It fails, and removes
# FILE, when COMMAND exits nonzero or prints nothing, so a partial or empty read never reaches a comparison.
checked_read() {
  _cr_file=$1
  shift
  if "$@" > "$_cr_file" && [ -s "$_cr_file" ]; then
    return 0
  fi
  rm -f "$_cr_file"
  echo 'checked_read: read failed or returned no rows' >&2
  return 1
}

# checked_sha256 FILE [sort]: prints the SHA-256 of FILE, or of its lines sorted with LC_ALL=C when "sort" is given.
# Fails, printing nothing, if FILE is missing or empty, or if hashing fails.
checked_sha256() {
  [ -s "$1" ] || return 1
  if [ "${2:-}" = sort ]; then
    _cs_out=$(LC_ALL=C sort "$1" | shasum -a 256) || return 1
  else
    _cs_out=$(shasum -a 256 < "$1") || return 1
  fi
  _cs_hash=${_cs_out%% *}
  [ "${#_cs_hash}" -eq 64 ] || return 1
  printf '%s\n' "$_cs_hash"
}

# checked_digest SQL COMMAND [ARG...]: sends SQL to COMMAND and prints the SHA-256 of its sorted output. It prints
# nothing and fails on a failed read, an empty result or a failed hash. A database with no user tables also fails,
# which is correct for a restored target. Use it as DIGEST=$(checked_digest ...) and stop when it fails.
checked_digest() {
  _cd_sql=$1
  shift
  _cd_file=$(mktemp) || return 1
  printf '%s\n' "$_cd_sql" | checked_read "$_cd_file" "$@" && checked_sha256 "$_cd_file" sort
  _cd_status=$?
  rm -f "$_cd_file"
  return "$_cd_status"
}

# same_digest EXPECTED ACTUAL: succeeds only when both are 64-character hashes and they are equal. An empty ACTUAL,
# which is what a failed read produces, never matches.
same_digest() {
  [ "${#1}" -eq 64 ] && [ "$1" = "$2" ]
}

# sequence_read_ok FILE: succeeds only for a complete SEQUENCE_SQL read: exactly one completion line whose two counts are
# equal (every sequence of the catalogue is readable by this role), and every other line a name and either a value or
# 'never-called'. An 'unknown' line (the role may not read that sequence), a failed, partial or empty read fails. A
# database with no sequences passes, because its complete read still prints the completion line with 0 and 0.
sequence_read_ok() {
  [ -s "$1" ] || return 1
  awk -F '\t' '
    $1 == "!complete" { done++; if (NF != 3 || $2 != $3) bad = 1; next }
    NF != 2 || $2 !~ /^(-?[0-9]+|never-called)$/ { bad = 1 }
    END { if (done == 1 && !bad) exit 0; exit 1 }' "$1"
}

# Every `checked_*` call below is a stop point: when it fails, the following lines of that step must not run.
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

# Sequence positions (a sequence advances on writes that the write counter below does not show). The first line is a
# completion line: '!complete', the number of sequences in the catalogue and the number this role may read (SELECT or
# USAGE on the sequence). Every other line is one sequence: its name and either its last value, 'never-called' (no value
# yet, with the privilege) or 'unknown' (no privilege). PostgreSQL 17's pg_sequences lists every sequence and shows NULL
# both for a never-called and for an unreadable one, so the view cannot tell them apart; the privilege is therefore
# tested here, before the value is read. has_sequence_privilege raises an error for a relation that is not a sequence,
# and the order of AND conditions is not fixed, so the call sits inside a CASE on relkind. sequence_read_ok rejects any
# 'unknown' line and any completion line whose counts differ. A failed, partial or empty read has no completion line.
# A database without sequences prints only the line, 0 and 0.
SEQUENCE_SQL="SELECT '!complete' || E'\t' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%') || E'\t' || (SELECT coalesce(sum(CASE WHEN c.relkind = 'S' THEN
    CASE WHEN has_sequence_privilege(c.oid, 'SELECT,USAGE') THEN 1 ELSE 0 END ELSE 0 END), 0)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%')
UNION ALL
SELECT n.nspname || '.' || c.relname || E'\t' || CASE
    WHEN NOT has_sequence_privilege(c.oid, 'SELECT,USAGE') THEN 'unknown'
    ELSE coalesce(pg_sequence_last_value(c.oid::regclass)::text, 'never-called') END
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY 1;"

# Write counter: rows inserted, updated or deleted through the statistics, all user schemas. It lags and it does not
# count TRUNCATE, so it is a sanity check; the comparison in _Post-point changes_ is the real evidence.
WRITE_COUNTER_SQL="SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) AS write_counter FROM pg_stat_user_tables;"

# Content digest source: one UNION ALL of per-table row hashes (table|md5 of each row as text), generated from the
# catalogue and executed with \gexec. Sort with LC_ALL=C and hash to get DIGEST: a single field changed in any row
# changes it. This, not the counters above, is the evidence used for rollback.
ROWHASH_SQL="SELECT string_agg(format('SELECT %L AS table_name, md5(x::text) AS row_md5 FROM %I.%I AS x', n.nspname || '.' || c.relname, n.nspname, c.relname), ' UNION ALL ' ORDER BY n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' \gexec"

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
   EXP_DIR=$(mktemp -d "$HOME/recovery-expect-XXXXXX") && chmod 700 "$EXP_DIR" && printf '%s\n' "$RUN_ID" > "$EXP_DIR/.recovery-owned"
   docker run -d --rm --log-driver none --name "$REF_NAME" \
     -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 "$IMAGE" > /dev/null
   until docker exec "$REF_NAME" pg_isready -q -U postgres; do sleep 1; done
   ( cd "$COMPAT_DIR" && npm ci && DATABASE_URL='postgresql://postgres@127.0.0.1:55432/postgres' npx prisma migrate deploy )
   EXPECTED_IDENTITY_SHA=$(checked_digest "$IDENTITY_SQL" docker exec -i "$REF_NAME" psql -X -q -A -t -U postgres -d postgres -v ON_ERROR_STOP=1 -f -)
   REF_IDENTITY_STATUS=$?
   REF_MIGRATION=$(docker exec "$REF_NAME" psql -X -q -A -t -U postgres -d postgres -v ON_ERROR_STOP=1 -c "$MIGRATION_SQL")
   REF_MIGRATION_STATUS=$?
   docker stop "$REF_NAME" > /dev/null
   printf 'EXPECTED_IDENTITY_SHA=%s\n' "$EXPECTED_IDENTITY_SHA"
   ```

   Stop unless `REF_IDENTITY_STATUS` and `REF_MIGRATION_STATUS` are both `0`, `EXPECTED_IDENTITY_SHA` is a 64-character
   hash, and `REF_MIGRATION` equals `EXPECTED_MIGRATION`.

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

Each option creates a **new** target, never the production database. Confirm the target provider, project and database
in its console before continuing.

1. **Point-in-time branch (Neon only).** Use a time before the incident, inside Neon's restore window for the plan.
   The Neon CLI takes the RFC 3339 time as its own `--parent` value; it does not accept a `branch@time` string, which
   it would look up as a branch name. The parent is the project's default branch, so the procedure first confirms
   that `$PROD_BRANCH` is that default branch, and the read-back checks the parent's id, not its name.

   The check is a self-contained shell function. It reads only the two branch-list files it is given, never a
   connection, and prints the branch id on stdout. Define it first:

   ```sh
   branch_check() {
     BC_MODE=$1 BC_BEFORE=$2 BC_AFTER=${3:-} BC_RECOVERY_BRANCH=$RECOVERY_BRANCH BC_PROD_BRANCH=$PROD_BRANCH \
     BC_PROD_BRANCH_ID=${PROD_BRANCH_ID:-} BC_RECOVERY_TIME=$RECOVERY_TIME \
       node --input-type=module <<'BRANCH_JS'
   import { readFileSync } from 'node:fs';

   const env = process.env;
   const fail = (why) => {
     console.error(`branch check failed: ${why}`);
     process.exit(1);
   };
   const load = (path) => {
     const value = JSON.parse(readFileSync(path, 'utf8'));
     const list = Array.isArray(value) ? value : value.branches;
     if (!Array.isArray(list)) fail('unexpected branch list format');
     return list;
   };
   // Canonical instant: UTC whole seconds plus the fraction without trailing zeros. Equal instants give equal
   // strings whatever their text form; different instants never do.
   const instant = (text) => {
     const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(String(text));
     if (!m) fail('timestamp is not RFC 3339 with a UTC offset');
     const sign = m[3][0] === '-' ? -1 : 1;
     const offsetSeconds =
       m[3] === 'Z' ? 0 : sign * (Number(m[3].slice(1, 3)) * 3600 + Number(m[3].slice(4, 6)) * 60);
     const fraction = (m[2] ?? '').replace(/0+$/, '');
     return `${Date.parse(`${m[1]}Z`) / 1000 - offsetSeconds}.${fraction}`;
   };

   if (env.BC_MODE === 'pre') {
     const list = load(env.BC_BEFORE);
     if (list.some((b) => b.name === env.BC_RECOVERY_BRANCH)) fail('recovery branch name already exists');
     const defaults = list.filter((b) => b.default === true);
     if (defaults.length !== 1 || defaults[0].name !== env.BC_PROD_BRANCH) {
       fail('default branch is not the confirmed production branch');
     }
     console.log(defaults[0].id);
   } else if (env.BC_MODE === 'post') {
     const known = new Set(load(env.BC_BEFORE).map((b) => b.id));
     const created = load(env.BC_AFTER).filter((b) => b.name === env.BC_RECOVERY_BRANCH && !known.has(b.id));
     if (created.length !== 1) fail('expected exactly one new branch with the recovery name; none identified');
     const [branch] = created;
     // The id is printed before any verdict: from here on the branch is identified, even if a check fails.
     console.log(branch.id);
     const problems = [];
     if (branch.parent_id !== env.BC_PROD_BRANCH_ID) problems.push('parent_id is not the production branch');
     if (instant(branch.parent_timestamp) !== instant(env.BC_RECOVERY_TIME)) {
       problems.push('parent_timestamp is not RECOVERY_TIME');
     }
     if (problems.length > 0) fail(problems.join('; '));
   } else {
     fail('mode must be pre or post');
   }
   BRANCH_JS
   }
   ```

   ```sh
   RECOVERY_TIME='<RFC 3339 UTC time before the bad change, e.g. 2026-11-24T10:00:00Z>'
   RECOVERY_BRANCH='recovery-<incident-id>'
   RECOVERY_DIR=$(mktemp -d "$HOME/recovery-branch-XXXXXX") && chmod 700 "$RECOVERY_DIR" && printf '%s\n' "$RUN_ID" > "$RECOVERY_DIR/.recovery-owned"
   BRANCHES_BEFORE="$RECOVERY_DIR/branches-before.json"
   neon branches list --project-id "$NEON_PROJECT_ID" --output json > "$BRANCHES_BEFORE"
   # Prints the confirmed production branch id, or fails. Fails too if RECOVERY_BRANCH already exists.
   PROD_BRANCH_ID=$(branch_check pre "$BRANCHES_BEFORE") && echo "production branch confirmed"
   ```

   Create the branch only if the check above printed `production branch confirmed`. Then read the project back. A branch is identified as
   this run's only when the create command itself succeeded; a branch with the same name created by someone else
   cannot then be mistaken for it, because the name is unique in the project:

   ```sh
   CREATE_STATUS=0
   neon branches create --project-id "$NEON_PROJECT_ID" --name "$RECOVERY_BRANCH" --parent "$RECOVERY_TIME" --no-secrets || CREATE_STATUS=$?
   neon branches list --project-id "$NEON_PROJECT_ID" --output json > "$RECOVERY_DIR/branches-after.json"
   if [ "$CREATE_STATUS" -ne 0 ]; then
     # Nothing is identified and nothing is deleted. Look at the list for $RECOVERY_BRANCH by hand and record it.
     echo "stop: create failed (status $CREATE_STATUS); the branch list must be checked by hand"
   elif ! BRANCH_OUT=$(branch_check post "$BRANCHES_BEFORE" "$RECOVERY_DIR/branches-after.json"); then
     # Fail closed: nothing is deleted here and no connection is made. The id printed before the verdict (if any) is
     # kept for the ticket; its removal is a separate operator decision, by that exact id only.
     RECOVERY_BRANCH_CANDIDATE=$BRANCH_OUT
     unset RECOVERY_BRANCH_ID
     echo 'stop: the recovery branch failed its read-back (reason above); record RECOVERY_BRANCH_CANDIDATE in the ticket'
   else
     RECOVERY_BRANCH_ID=$BRANCH_OUT
   fi
   ```

   The post-check passes only when there is exactly one new branch named `$RECOVERY_BRANCH`, its `parent_id` equals
   `PROD_BRANCH_ID`, and its `parent_timestamp` is the same instant as `RECOVERY_TIME`. Instants are compared as UTC
   instants, not as text, so `Z`, `+00:00`, a different offset for the same instant, or trailing zeros in the fraction
   all match, while any difference in the instant does not. The printed id is the branch's id; record the parent id
   and timestamp in the ticket. Then capture the direct owner URL into a variable (not printed):

   ```sh
   TARGET_URL=$(neon connection-string "$RECOVERY_BRANCH_ID" --project-id "$NEON_PROJECT_ID" --database-name '<database-name>' --role-name '<owner-role>')
   load_libpq_env "$TARGET_URL"
   ```

   `--no-secrets` keeps the connection string out of the create command's output. The direct URL (no `--pooled`) is
   the restore role's.

2. **Encrypted copy (Neon branch; for another provider use step 3).** A Neon branch inherits its parent's databases,
   so create a new database inside a new branch and use only that database. It must be verified empty (below) before
   any restore.

   ```sh
   RESTORE_BRANCH='restore-<incident-id>'
   RESTORE_DB='<new-database-name>'
   neon branches create --project-id "$NEON_PROJECT_ID" --name "$RESTORE_BRANCH" --no-secrets
   neon databases create --project-id "$NEON_PROJECT_ID" --branch "$RESTORE_BRANCH" --name "$RESTORE_DB" --owner-name '<owner-role>'
   TARGET_URL=$(neon connection-string "$RESTORE_BRANCH" --project-id "$NEON_PROJECT_ID" --database-name "$RESTORE_DB" --role-name '<owner-role>')
   load_libpq_env "$TARGET_URL"
   ```

3. **Another provider, or Neon unavailable.** Provision PostgreSQL 17 with a fresh empty database and TLS at any provider
   (the provider's own steps are not covered here). Nothing in the restore, the empty-target check or the verification
   of an encrypted copy needs Neon or the old source. Enter the direct URL without echo:

   ```sh
   printf 'Direct URL of the NEW empty database (not echoed): '
   read -rs TARGET_URL
   echo
   load_libpq_env "$TARGET_URL"
   ```

   A target created here is cut over with a runtime-role URL from the same provider, entered by hidden prompt (see
   _Switch_).

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
copy and its `meta/` directory (for example, `~/Projects/clickmoji-shop/backups` in the main checkout). The directory
is mounted read-only. `TARGET_URL` must be the new empty database from the previous step, never production. The libpq
variables come from it through `load_libpq_env` and reach the container by name only.

For an unencrypted verified copy (`clickmoji-<UTC timestamp>.dump`, used when `BACKUP_ENCRYPT` is off), replace the
`age -d ... | pg_restore ...` pipeline with a direct `pg_restore` against `"/backup/$BACKUP_FILE"`:

```sh
pg_run -v "$BACKUP_DIR:/backup:ro" -e BACKUP_FILE "$IMAGE" sh -c '
  pg_restore --no-owner --no-privileges --exit-on-error --dbname "$PGDATABASE" "/backup/$BACKUP_FILE"
'
```

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
- `verify`: `ok` for an accepted copy (including one accepted via `--allow-row-drop`). Copies with a >20% table row drop without `--allow-row-drop` are rejected before publishing; legacy records may carry `suspicious`, which is an operator decision, not a pass.
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
   same_digest "$EXPECTED_IDENTITY_SHA" "$(checked_digest "$IDENTITY_SQL" psql_stdin)" && echo "schema: matches the compatible release"
   ```

5. every `EXPECTATIONS` check passes.

If the record's `verify` is `suspicious`, or the record's migration differs from `EXPECTED_MIGRATION`, stop and decide
as an operator. Do not run `prisma migrate deploy` against restored data.

**Restore-ready** is the separate result of this section, recorded in the ticket with the copy's name, `RP_CREATED_AT`
and the five outcomes. It means the target holds the copy as recorded and nothing more. It needs no Neon CLI, no Neon
branch, no reachable old source and no fence, and it does not authorize a switch. The switch has its own preconditions
in _Switch_.

#### Verify the point-in-time branch

A branch has no record and no counts to compare exactly, and production today is not the reference (it may already
contain the bad change). The branch is checked against the **expectations**, never against production's current
schema or migration, and it does not need any copy record.

Pass only when **all** of these hold, all run on the branch:

1. the branch's parent and parent timestamp were confirmed in _Create the target_ (recorded in the ticket);
2. the schema identity equals the reference's, line for line:

   ```sh
   same_digest "$EXPECTED_IDENTITY_SHA" "$(checked_digest "$IDENTITY_SQL" psql_stdin)" && echo "schema: matches the compatible release"
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

#### Write barrier (the runtime role, on both databases)

A stop that rests on a deployment is not enough. Vercel can move the production domain to another deployment at any time,
and a deployment that still holds a production URL can write. A maintenance deployment, even a promoted one, is therefore
not a barrier by itself. The write barrier is enforced by the database instead: it removes the runtime role's write
privileges, the only role that site deployments use, on production and on the target. It holds whichever deployment
serves the domain. It removes direct INSERT, UPDATE, DELETE and TRUNCATE on tables and views, and UPDATE and USAGE on
sequences. Reads stay allowed, so the routing proof can read without writing.

The barrier counts only if, once closed, the runtime role has no effective write privilege from any source. Effective
privileges include `PUBLIC` and role membership, which a revoke does not change. `BARRIER_CHECK_SQL` tests exactly that; if
it prints any row, the barrier is not independent and the cutover is held. Reopening restores the direct grants saved
before closing, and the effective grants must then equal the snapshot taken before closing. The barrier does not stop the
other writers (see _Fence production_).

```sh
export RUNTIME_ROLE='<runtime-role>'
BARRIER_PSQL='psql -X -q -A -t -v ON_ERROR_STOP=1 -v role="$RUNTIME_ROLE" -f -'

# prints_no_rows: succeeds only when the query exits 0 and prints no rows. An empty output is valid only here.
prints_no_rows() {
  _pn_file=$(mktemp) || return 1
  "$@" > "$_pn_file"
  _pn_status=$?
  [ "$_pn_status" -eq 0 ] && [ ! -s "$_pn_file" ]
  _pn_result=$?
  rm -f "$_pn_file"
  return "$_pn_result"
}

# Direct write grants of the runtime role, as GRANT statements that restore them. Read-only; saved before closing.
BARRIER_OPEN_SQL=$(cat <<'SQL'
SELECT format('GRANT %s ON %s %I.%I TO %I;', a.privilege_type, CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
              n.nspname, c.relname, g.rolname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
JOIN pg_roles g ON g.oid = a.grantee
WHERE g.rolname = :'role'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  AND ((c.relkind IN ('r', 'p', 'v', 'f') AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
    OR (c.relkind = 'S' AND a.privilege_type IN ('USAGE', 'UPDATE')))
ORDER BY 1;
SQL
)

# The same filter as BARRIER_OPEN_SQL, as REVOKE statements.
BARRIER_CLOSE_SQL=$(cat <<'SQL'
SELECT format('REVOKE %s ON %s %I.%I FROM %I;', a.privilege_type, CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
              n.nspname, c.relname, g.rolname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
JOIN pg_roles g ON g.oid = a.grantee
WHERE g.rolname = :'role'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  AND ((c.relkind IN ('r', 'p', 'v', 'f') AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
    OR (c.relkind = 'S' AND a.privilege_type IN ('USAGE', 'UPDATE')))
ORDER BY 1;
SQL
)

# Effective write privileges of the runtime role, from any source. Must print no rows once the barrier is closed.
BARRIER_CHECK_SQL=$(cat <<'SQL'
SELECT n.nspname || '.' || c.relname || E'\t' || p.priv
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
WHERE c.relkind IN ('r', 'p', 'v', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  AND has_table_privilege(:'role', c.oid, p.priv)
UNION ALL
SELECT n.nspname || '.' || c.relname || E'\t' || p.priv
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('UPDATE'), ('USAGE')) AS p(priv)
WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  AND has_sequence_privilege(:'role', c.oid, p.priv);
SQL
)

# GRANTS_CHECK_SQL: the effective grants of the runtime role as one SHA-256, computed by the server from GRANTS_SQL's own
# rows, sorted with COLLATE "C" (the same bytes as checked_sha256 ... sort). \gset stores the result in grants_ok.
GRANTS_CHECK_SQL="WITH g(line) AS (${GRANTS_SQL%;})
SELECT encode(sha256(convert_to(coalesce(string_agg(line, E'\n' ORDER BY line COLLATE \"C\"), '') || E'\n', 'UTF8')), 'hex')
       = :'expected_sha' AS grants_ok
FROM g \gset"

# The reopen runs inside one transaction (reopen_barrier). The role and the expected hash come from the environment.
REOPEN_PSQL='psql -X -q -A -t -v ON_ERROR_STOP=1 -v role="$RUNTIME_ROLE" -v expected_sha="$EXPECTED_GRANTS_SHA" -f -'

# reopen_barrier OWNER_URL OPEN_FILE SNAPSHOT LABEL: the one point that opens a barrier. OPEN_FILE (the saved GRANTs) and the
# exact comparison run in ONE transaction, and COMMIT is reached only when the effective grants equal SNAPSHOT. A failed
# statement or a mismatch ends the transaction without COMMIT, so the barrier stays closed. A failure reported after the
# command started (including a COMMIT whose acknowledgement was lost, which leaves the barrier open) is unknown, and the
# caller closes the barrier again with reclose_barrier. A success line is not a routing permission: the caller prints
# `... reopened, grants identical` only after the independent read agrees.
reopen_barrier() {
  load_libpq_env "$1" || return 1
  EXPECTED_GRANTS_SHA=$(checked_sha256 "$3" sort) || return 1
  export EXPECTED_GRANTS_SHA
  {
    printf '%s\n' 'BEGIN;'
    cat "$2" || return 1
    printf '%s\n' "$GRANTS_CHECK_SQL"
    printf '%s\n' '\if :grants_ok' 'COMMIT;' '\else' 'ROLLBACK;' \
      "DO \$reopen\$ BEGIN RAISE EXCEPTION 'reopen $4 refused: effective grants differ from the snapshot; rolled back'; END \$reopen\$;" \
      '\endif'
  } > "$DIFF_DIR/reopen-$4.sql" || return 1
  # psql exits nonzero on the RAISE (ON_ERROR_STOP), and on any failed statement; only a COMMIT leaves it at 0.
  if pg_run -i -e RUNTIME_ROLE -e EXPECTED_GRANTS_SHA "$IMAGE" sh -c "$REOPEN_PSQL" < "$DIFF_DIR/reopen-$4.sql"; then
    echo "reopen $4: committed after the in-transaction comparison"
  else
    echo "reopen $4: not confirmed (refused, failed, or COMMIT unacknowledged); closing the barrier again" >&2
    return 1
  fi
}

# reclose_barrier OWNER_URL CLOSE_FILE LABEL: closes one barrier again, in one transaction, and prints `barrier LABEL: closed`
# only when BARRIER_CHECK_SQL prints no row. The check runs in a separate process after the close transaction has ended,
# and for production it reads through the read-only role. Closing is always safe. If that line does not print, the
# database is open or unknown: its writers stay stopped and the cutover is held.
reclose_barrier() {
  load_libpq_env "$1" || return 1
  pg_run -i "$IMAGE" sh -c 'psql -X -q -1 -v ON_ERROR_STOP=1 -f -' < "$2" || return 1
  if [ "$3" = production ]; then
    prints_no_rows prod_ro pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$BARRIER_CHECK_SQL"
  else
    prints_no_rows pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$BARRIER_CHECK_SQL"
  fi && echo "barrier $3: closed"
}

# close_file_ok FILE: succeeds only for a non-empty saved close file that contains no GRANT statement.
close_file_ok() {
  [ -n "${DIFF_DIR:-}" ] && [ -s "$1" ] && ! grep -qi '^GRANT' "$1" \
    || { echo "close-only refused: $1 is missing, empty or contains GRANT" >&2; return 1; }
}

# close_only_target and close_only_production: the ONLY retries for a barrier whose state is open or unknown, after a
# close attempt failed or after any reopen attempt started. Each runs reclose_barrier on the close file saved by
# _Write barrier_ and nothing else: no snapshot or open file is read or rewritten, reopen_barrier is never called, and no
# GRANT statement can run. The writers of that database stay stopped until its `barrier LABEL: closed` line is printed.
close_only_target() {
  close_file_ok "$DIFF_DIR/barrier-target-close.sql" && reclose_barrier "$TARGET_URL" "$DIFF_DIR/barrier-target-close.sql" target
}
close_only_production() {
  close_file_ok "$DIFF_DIR/barrier-prod-close.sql" && reclose_barrier "$PROD_OWNER_URL" "$DIFF_DIR/barrier-prod-close.sql" production
}
```

Before the first barrier step, in this shell, the procedure creates its private directory **once**, under the operator's home
directory (the only trusted root). An inherited `DIFF_DIR` value is discarded, never reused and never cleaned up: the variable
is unset first, and the directory is new, private (`chmod 700`), owned by the operator, not a link, and its marker file holds
this attempt's `RUN_ID` (_Shell and prerequisites_), which the final cleanup checks. Run this block once per recovery; a second run creates another directory, and the snapshots of
the first would then not be the ones compared. Every later step uses the same `DIFF_DIR`: the snapshots taken here are what the
reopen steps of _Switch_ and _Rollback_ compare against (_Post-point changes_ uses it as it is).

```sh
# A new private directory for this recovery. An inherited DIFF_DIR is never used: it is unset before the directory is made.
unset DIFF_DIR
DIFF_DIR=$(mktemp -d "$HOME/recovery-diff-XXXXXX") && chmod 700 "$DIFF_DIR" && [ -O "$DIFF_DIR" ] && [ ! -L "$DIFF_DIR" ] \
  && printf '%s\n' "$RUN_ID" > "$DIFF_DIR/.recovery-owned" || DIFF_DIR=''
[ -n "$DIFF_DIR" ] && [ -d "$DIFF_DIR" ] && echo 'DIFF_DIR: ready'
printf 'Owner URL of production (not echoed): '
read -rs PROD_OWNER_URL
echo
```

Stop unless `DIFF_DIR: ready` is printed. `PROD_OWNER_URL` is used only by the production close and reopen.

Close **production** while the fence is being established (step 1, after the writers are stopped). The save and the check
are reads through `prod_ro`; only the two changes use `PROD_OWNER_URL`. Each line is a stop point: do not run the next line
when one fails.

```sh
# Production: close the runtime role's write barrier. Run once, before any reopen attempt; a retry uses close_only_production.
checked_read "$DIFF_DIR/barrier-prod-open.sql" prod_ro pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$BARRIER_OPEN_SQL"
checked_read "$DIFF_DIR/barrier-prod-close.sql" prod_ro pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$BARRIER_CLOSE_SQL"
checked_read "$DIFF_DIR/grants-prod-pre-barrier.txt" prod_ro pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$GRANTS_SQL"
load_libpq_env "$PROD_OWNER_URL" && pg_run -i "$IMAGE" sh -c 'psql -X -q -1 -v ON_ERROR_STOP=1 -f -' < "$DIFF_DIR/barrier-prod-close.sql"
prints_no_rows prod_ro pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$BARRIER_CHECK_SQL" && echo "barrier production: closed"
```

The **target** is closed at the start of the switch (_Switch_, step 1), with the same lines, against the target's owner URL
(`TARGET_URL`), before any Vercel change:

```sh
# Target: close the runtime role's write barrier, with the owner URL in the main shell. Run once, before any reopen attempt.
# This block rewrites the saved open file and snapshot, so it is never run again as a retry: use close_only_target.
load_libpq_env "$TARGET_URL"
checked_read "$DIFF_DIR/barrier-target-open.sql" pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$BARRIER_OPEN_SQL"
checked_read "$DIFF_DIR/barrier-target-close.sql" pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$BARRIER_CLOSE_SQL"
checked_read "$DIFF_DIR/grants-target-pre-barrier.txt" pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$GRANTS_SQL"
pg_run -i "$IMAGE" sh -c 'psql -X -q -1 -v ON_ERROR_STOP=1 -f -' < "$DIFF_DIR/barrier-target-close.sql"
prints_no_rows pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$BARRIER_CHECK_SQL" && echo "barrier target: closed"
```

**Reopening** is done only at the step that allows it (_Switch_ step 7, or _Rollback_), and each database is reopened on its
own by `reopen_barrier`. The barrier opens at one point only: the COMMIT that `reopen_barrier` reaches after the saved GRANTs
and the exact comparison of the effective grants with the snapshot taken before closing succeed in **one transaction**
(`ON_ERROR_STOP`). A mismatch, a failed read or a failed statement rolls back, so nothing is granted. The independent read
after the commit is a check of that result, and it does not decide whether the barrier is open. Once a COMMIT may have
happened, the barrier counts as open until a `barrier ...: closed` line shows otherwise. So any failure after the reopen
starts (a lost acknowledgement, a failed independent read, a grant mismatch) closes the barrier again with
`reclose_barrier`, using the close file of _Write barrier_. Writers may use a database only after its line
`... reopened, grants identical` is printed; that line is the routing condition, not the barrier.

**Each reopen block below is run once per recovery.** Once a reopen attempt has started for a database, no reopen block and
no `reopen_barrier` call is repeated for it in this recovery, whatever the outcome. Retries for that database use only
`close_only_target` or `close_only_production`, which close the barrier and never grant anything. A database whose
`barrier ...: closed` line has not printed keeps its writers stopped and the cutover held. A new reopen, if the operator
decides one, is a new recovery with a fresh snapshot.

```sh
# Reopen production (PROD_OWNER_URL), only when the routing proof allows it, once. Any failure closes the barrier again
# with reclose_barrier. Retries: close_only_production.
reopen_barrier "$PROD_OWNER_URL" "$DIFF_DIR/barrier-prod-open.sql" "$DIFF_DIR/grants-prod-pre-barrier.txt" production \
  && checked_read "$DIFF_DIR/grants-prod-after-open.txt" prod_ro pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$GRANTS_SQL" \
  && cmp -s "$DIFF_DIR/grants-prod-pre-barrier.txt" "$DIFF_DIR/grants-prod-after-open.txt" && echo "production barrier: reopened, grants identical" \
  || reclose_barrier "$PROD_OWNER_URL" "$DIFF_DIR/barrier-prod-close.sql" production
```

```sh
# Reopen target (TARGET_URL), only at the step of _Switch_ or _Rollback_ that allows it, once. Any failure closes the barrier
# again with reclose_barrier. Retries: close_only_target.
reopen_barrier "$TARGET_URL" "$DIFF_DIR/barrier-target-open.sql" "$DIFF_DIR/grants-target-pre-barrier.txt" target \
  && checked_read "$DIFF_DIR/grants-target-after-open.txt" pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$BARRIER_PSQL" <<< "$GRANTS_SQL" \
  && cmp -s "$DIFF_DIR/grants-target-pre-barrier.txt" "$DIFF_DIR/grants-target-after-open.txt" && echo "target barrier: reopened, grants identical" \
  || reclose_barrier "$TARGET_URL" "$DIFF_DIR/barrier-target-close.sql" target
```

#### Fence production

Order matters, and it is fixed:

0. the identity probe of _Runtime role on the target_ has passed. It writes only to the target, so a failure is known
   before any writer is stopped;
1. stop writers (step 1 below), then close the production write barrier (_Write barrier_);
2. verify the fence (step 2), until it passes, with the barrier check at each run;
3. record the counters from frozen production (step 3);
4. only then deploy anything to Vercel, or let anything write to the target.

Step 1: **stop every writer** and record each one in the ticket with the method used and the time. Writers are listed
in the terms above. The operator's methods, for example:

- Vercel: put production into maintenance by the operator's method, and confirm that no older production deployment still
  serves requests or runs scheduled work. A maintenance deployment is not the barrier: the write barrier (_Write barrier_)
  is required in addition, because the domain can move;
- GitHub: disable runs of `migrate-production.yml` and confirm no run is in progress. Backups: run
  `gh workflow list --all` and check that no backup workflow is active. On master none is expected (`db-backup.yml` was
  removed in #159), and that absence is recorded in the ticket. If a backup workflow is active, pause it for the window
  and confirm no run is in progress. The backup copy for the recovery is the operator-approved, verified manual copy
  (_Verify the encrypted copy_), when one is available; when none is, the ticket records that no copy was taken;
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
- **Write barrier.** `BARRIER_CHECK_SQL` on production, read through `prod_ro`, prints no row on each run, and the line
  `barrier production: closed` was printed after the barrier was closed (_Write barrier_).

Step 3: **record the counters from frozen production**, read through `prod_ro`, after step 2 has passed on the run
that defines `FROZEN_AT`:

```sh
FROZEN_AT='<UTC time of the last passing fence check>'
WRITE_BASELINE=$(prod_ro pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<< "$WRITE_COUNTER_SQL")
# The sequence baseline is a checked read: a failed, partial or hidden-sequence read leaves SEQ_BASELINE unset (see sequence_read_ok).
unset SEQ_BASELINE
checked_read "$DIFF_DIR/seq-prod-baseline.txt" prod_ro pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<< "$SEQUENCE_SQL" \
  && sequence_read_ok "$DIFF_DIR/seq-prod-baseline.txt" && SEQ_BASELINE="$DIFF_DIR/seq-prod-baseline.txt"
PRE_STOP_COUNTS=$(prod_ro pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$COUNTS_SQL")
PRE_STOP_IDENTITY_SHA=$(checked_digest "$IDENTITY_SQL" prod_ro psql_stdin)
PRE_STOP_DIGEST=$(checked_digest "$ROWHASH_SQL" prod_ro psql_stdin)
printf 'FROZEN_AT=%s write_baseline=%s identity=%s digest=%s\n' "$FROZEN_AT" "$WRITE_BASELINE" "$PRE_STOP_IDENTITY_SHA" "$PRE_STOP_DIGEST"
```

Stop unless `PRE_STOP_IDENTITY_SHA` and `PRE_STOP_DIGEST` are both 64-character hashes, `SEQ_BASELINE` is set (the sequence
baseline is complete) and the other reads above printed their values. Record `FROZEN_AT`, `WRITE_BASELINE`, the sequence
baseline (`seq-prod-baseline.txt`), `PRE_STOP_COUNTS`, `PRE_STOP_IDENTITY_SHA` and
`PRE_STOP_DIGEST` in the ticket. They are the old database's state for the rollback check. `PRE_STOP_DIGEST` is the one
that counts: the counters are kept for the record and are never proof that nothing was written.

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
# DIFF_DIR and the owner URL were set up once, in _Write barrier_. Nothing here creates DIFF_DIR again.

# compare_post_point: every read, sort, comm and sequence check runs in this function, in order. Each step returns 1
# when it fails, so no later step runs. It first removes its own cmp-* artifacts, so output left by an earlier run in
# the same DIFF_DIR can never be shown. It writes the whole report to cmp-report.txt in one step at the end, so a report
# exists only when every step has passed. Only the caller shows it, and only after it has read the whole file.
compare_post_point() {
  find "$DIFF_DIR" -maxdepth 1 -name 'cmp-*' -type f -exec rm -f {} + || return 1
  checked_read "$DIFF_DIR/cmp-identity-prod.txt" prod_ro psql_stdin <<< "$IDENTITY_SQL" || return 1
  load_libpq_env "$TARGET_URL" || return 1
  checked_read "$DIFF_DIR/cmp-identity-target.txt" psql_stdin <<< "$IDENTITY_SQL" || return 1
  checked_read "$DIFF_DIR/cmp-prod.txt" prod_ro psql_stdin <<< "$ROWHASH_SQL" || return 1
  load_libpq_env "$TARGET_URL" || return 1
  checked_read "$DIFF_DIR/cmp-target.txt" psql_stdin <<< "$ROWHASH_SQL" || return 1
  checked_read "$DIFF_DIR/cmp-target-seq.txt" pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$SEQUENCE_SQL" || return 1
  sequence_read_ok "$DIFF_DIR/cmp-target-seq.txt" || return 1
  sequence_read_ok "$SEQ_BASELINE" || return 1
  LC_ALL=C sort "$DIFF_DIR/cmp-identity-prod.txt" > "$DIFF_DIR/cmp-identity-prod.sorted" || return 1
  LC_ALL=C sort "$DIFF_DIR/cmp-identity-target.txt" > "$DIFF_DIR/cmp-identity-target.sorted" || return 1
  LC_ALL=C sort "$DIFF_DIR/cmp-prod.txt" > "$DIFF_DIR/cmp-prod.sorted" || return 1
  LC_ALL=C sort "$DIFF_DIR/cmp-target.txt" > "$DIFF_DIR/cmp-target.sorted" || return 1
  LC_ALL=C comm -3 "$DIFF_DIR/cmp-identity-prod.sorted" "$DIFF_DIR/cmp-identity-target.sorted" \
    | sed 's/^\t//' | cut -f1 | LC_ALL=C sort -u > "$DIFF_DIR/cmp-schema.out" || return 1
  LC_ALL=C comm -23 "$DIFF_DIR/cmp-prod.sorted" "$DIFF_DIR/cmp-target.sorted" \
    | cut -d'|' -f1 | LC_ALL=C sort | uniq -c > "$DIFF_DIR/cmp-only-prod.out" || return 1
  LC_ALL=C comm -13 "$DIFF_DIR/cmp-prod.sorted" "$DIFF_DIR/cmp-target.sorted" \
    | cut -d'|' -f1 | LC_ALL=C sort | uniq -c > "$DIFF_DIR/cmp-only-target.out" || return 1
  # Sequences: the completion lines are dropped and the rest are name<TAB>state, where state is a value, 'never-called' or
  # 'unknown' (already rejected above). The two files are told apart by FILENAME, not by NR == FNR: with an empty target
  # list NR == FNR would also hold for the production lines, and a missing sequence would pass. A production sequence that
  # was never called has handed out no value, so it has nothing to protect. A target sequence that was never called starts
  # at its start value, which is not known to be beyond a production value, so it counts as behind.
  awk -F '\t' '$1 != "!complete"' "$DIFF_DIR/cmp-target-seq.txt" > "$DIFF_DIR/cmp-target-seq.rows" || return 1
  awk -F '\t' '$1 != "!complete"' "$SEQ_BASELINE" > "$DIFF_DIR/cmp-prod-seq.rows" || return 1
  awk -F '\t' 'FILENAME == ARGV[1] { tgt[$1] = $2; next } { if (!($1 in tgt)) { print "missing in target: " $1; next } if ($2 == "never-called") next; if (tgt[$1] == "never-called" || tgt[$1] + 0 < $2 + 0) print "behind: " $1 }' \
    "$DIFF_DIR/cmp-target-seq.rows" "$DIFF_DIR/cmp-prod-seq.rows" > "$DIFF_DIR/cmp-seq.out" || return 1
  [ ! -s "$DIFF_DIR/cmp-seq.out" ] || return 1
  { echo 'schema differs:' && cat "$DIFF_DIR/cmp-schema.out" \
    && echo 'created or changed after RP (only in production):' && cat "$DIFF_DIR/cmp-only-prod.out" \
    && echo 'deleted or changed after RP (only in target):' && cat "$DIFF_DIR/cmp-only-target.out" \
    && echo 'sequences: no missing or behind sequence'; } > "$DIFF_DIR/cmp-report.tmp" || return 1
  mv "$DIFF_DIR/cmp-report.tmp" "$DIFF_DIR/cmp-report.txt" || return 1
}

# The report is read back whole and printed in one step. "complete" is printed only after that, never on failure.
if compare_post_point && REPORT=$(cat "$DIFF_DIR/cmp-report.txt") && [ -n "$REPORT" ]; then
  printf '%s\n' "$REPORT"
  echo 'post-point comparison: complete'
else
  echo 'post-point comparison FAILED: cutover held; no comparison result is evidence' >&2
  cat "$DIFF_DIR/cmp-seq.out" >&2 2>/dev/null   # diagnostic only, never evidence
  false
fi
```

The `cmp-prod.txt` and `cmp-target.txt` files are rows of `table|md5`; they hold no row data. The `prod_ro` subshell loads
the read-only production URL; the target then loads `TARGET_URL` in the main shell.

The sequence positions are compared inside the same function. Both lists must be complete reads (`sequence_read_ok`): the
production list is the baseline recorded at `FROZEN_AT` (`seq-prod-baseline.txt`), the target list is read now. Every
sequence of frozen production must exist in the target with a `last_value` at least as large, so ids used by production
rows are never reused after writes resume. A missing or behind sequence is printed on failure (`cmp-seq.out`). A failed,
partial or hidden-sequence read on either side, a missing or behind sequence, holds the cutover like any other failed
step. A database with no sequences passes only when both reads are complete and empty.

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
# The same GRANTS_SQL and OWNERSHIP_SQL run on production and on the target (owner role): the outputs must be identical,
# and OWNERSHIP_SQL must return no rows. Production's side is the snapshot taken before its write barrier closed
# (_Write barrier_), because a closed barrier changes its live grants. The target's barrier is still open here.
ROLE_PSQL='psql -X -q -A -t -v ON_ERROR_STOP=1 -v role="$RUNTIME_ROLE" -f -'
load_libpq_env "$TARGET_URL"
checked_read "$DIFF_DIR/grants-target.txt" pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$ROLE_PSQL" <<< "$GRANTS_SQL"
cmp -s "$DIFF_DIR/grants-prod-pre-barrier.txt" "$DIFF_DIR/grants-target.txt" && echo "grants: identical"
prints_no_rows pg_run -i -e RUNTIME_ROLE "$IMAGE" sh -c "$ROLE_PSQL" <<< "$OWNERSHIP_SQL" && echo "ownership: none"
```

Then obtain the runtime URL and check that it reaches the target as the runtime role. Its attributes must be `f` for
`rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolbypassrls` and `can_create_in_public`.

On Neon the URL comes from the CLI:

```sh
CUTOVER_URL=$(neon connection-string "$RESTORE_BRANCH" --project-id "$NEON_PROJECT_ID" --database-name "$RESTORE_DB" --role-name '<runtime-role>' --pooled)
# For a point-in-time branch use "$RECOVERY_BRANCH_ID" and its database instead.
```

Outside Neon, the runtime-role URL comes from the target's provider and is entered by hidden prompt, never typed into a
command or a file:

```sh
printf 'Runtime-role URL of the target (not echoed): '
read -rs CUTOVER_URL
echo
```

Then, for either source:

```sh
load_libpq_env "$CUTOVER_URL"
pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<'SQL'
SELECT current_database(), current_user, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public
FROM pg_roles WHERE rolname = current_user;
SQL
```

Expected: `<database>|<runtime-role>|f|f|f|f|f`. Anything else stops the switch.

#### Identity probe (both URLs reach the same database)

Equal database names, roles and migrations do not show that two URLs reach the same database: another cluster can have
all of them. The probe uses the cluster itself. The owner writes a one-time random value that exists only on the target,
the runtime role must read it back exactly, and the cluster identifier must match. It writes only to the target, and it
must pass before the fence and before `TARGET_BASELINE` is recorded. Any failure holds the switch.

```sh
PROBE_NAME="clickmoji_probe_$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
PROBE_NONCE=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
IDENTITY_QUERY="SELECT system_identifier || '|' || current_database() || '|' || pg_is_in_recovery() FROM pg_control_system();"

# 1. Owner identity, through the owner URL:
load_libpq_env "$TARGET_URL"
OWNER_ID=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_QUERY")

# 2. Owner writes the nonce and grants SELECT only. Steps 3 and 4 run only if this step exits 0.
pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<SQL
CREATE TABLE public."$PROBE_NAME" (nonce text NOT NULL);
INSERT INTO public."$PROBE_NAME" (nonce) VALUES ('$PROBE_NONCE');
GRANT SELECT ON public."$PROBE_NAME" TO "$RUNTIME_ROLE";
SQL
PROBE_WRITE_STATUS=$?

# 3. Runtime identity and the nonce, through the runtime URL:
load_libpq_env "$CUTOVER_URL"
RUNTIME_ID=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_QUERY")
RUNTIME_NONCE=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "SELECT nonce FROM public.\"$PROBE_NAME\";")

# 4. Pass only when every value agrees: the write exited 0, both identities are equal and not in recovery, and the
#    nonce read back through the runtime URL is exactly the one written (an empty or multi-row result fails the match).
[ "$PROBE_WRITE_STATUS" -eq 0 ] && [ -n "$OWNER_ID" ] && [ "$OWNER_ID" = "$RUNTIME_ID" ] \
  && [ "${OWNER_ID##*|}" = false ] && [ "$RUNTIME_NONCE" = "$PROBE_NONCE" ] && echo "identity probe: same target"

# 5. Always runs, pass or fail: the owner removes the probe and the absence is verified by the owner.
load_libpq_env "$TARGET_URL"
pg_run -i "$IMAGE" sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 -f -' <<SQL
DROP TABLE IF EXISTS public."$PROBE_NAME";
SQL
PROBE_CLEAN=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "SELECT coalesce(to_regclass('public.\"$PROBE_NAME\"')::text, 'absent');")
[ "$PROBE_CLEAN" = absent ] && echo "probe removed"
```

The identity probe passes only when step 4 prints `identity probe: same target` **and** step 5 prints `probe removed`. If
step 4 fails, step 5 must still run; the switch is then held, and the target is not used for `TARGET_BASELINE` until the
probe is removed and its absence is verified. The probe name and nonce are kept in shell variables only, and are not
recorded in the ticket. Record the result (`identity probe: same target`, `probe removed`) and no other values.

Migrate status through the runtime URL is read-only and must show the compatible release's migrations as applied, with
`EXPECTED_MIGRATION` as the latest and no pending or failed migration:

```sh
( cd "$COMPAT_DIR" && DATABASE_URL="$CUTOVER_URL" npx prisma migrate status )
```

Never run `prisma migrate deploy` with this URL. If the runtime role cannot read the migration table, its grants differ
from production's: stop, and the cutover is held.

#### Vercel production-only setting

- In the Vercel dashboard (Project Settings → Environment Variables), confirm that the existing `DATABASE_URL` entry is
  scoped to **Production only**. If it also covers Preview or Development, stop: updating the entry changes every
  environment that it covers. Split the entry in the dashboard first; that is an operator action.
- Run the CLI from the linked release checkout and confirm `.vercel/project.json` names the Clickmoji production project.
- Use the documented positional Production selector, `vercel env update DATABASE_URL production --yes`. Confirm
  that the installed CLI supports `vercel env update --help` before starting the switch.
- Boundary: the command changes only the Production entry of `DATABASE_URL`. The dashboard scope check above is what
  guarantees that no Preview or Development entry is covered, so it is repeated before the switch.

#### Switch (real incident only, after every check and decision above)

Preconditions, all recorded in the ticket:

- **restore-ready** for the target (its copy or branch verification passed);
- **old source reachable and fenced**: the fence passed on the run that defines `FROZEN_AT`, the production write barrier
  printed `barrier production: closed`, and the `prod_ro` reads of the post-point comparison succeed. Without them the fence
  and the post-point changes cannot be established;
- the post-point decision is written (reconcile or accept loss), and `compare_post_point` completed: the line
  `post-point comparison: complete` was printed;
- the runtime identity and the migrate status passed on `CUTOVER_URL`, and the identity probe passed in full (see
  _Identity probe_).

**Cutover is held** while any precondition is missing, in particular while the old source cannot be read or fenced. Then
nothing changes in Vercel, the target stays restore-ready, and the hold is recorded in the ticket with its time and reason.
This procedure has no route around the hold; any other action is a separate operator decision outside this text.

1. **Close the target's write barrier** (the target close block of _Write barrier_, run once), before any Vercel change.
   Nothing below runs until `barrier target: closed` is printed. A retry is `close_only_target` and nothing else; the close
   block is not run again.

2. Record `TARGET_BASELINE` **before** any Vercel change, while the target has no writer. The content digest is the
   baseline that decides a rollback; the counters are recorded for the record only. All are read as the owner role.
   Confirm in the same session, with a role that can see all sessions, that the target has no client session other than
   the operator's (the sessions query from _Fence production_ with `datname` of the target):

   ```sh
   load_libpq_env "$TARGET_URL"
   TARGET_BASELINE_DIGEST=$(checked_digest "$ROWHASH_SQL" psql_stdin)
   TARGET_BASELINE_WRITES=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$WRITE_COUNTER_SQL")
   TARGET_BASELINE_SEQUENCES=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$SEQUENCE_SQL")
   TARGET_BASELINE_COUNTS=$(pg_run "$IMAGE" psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$COUNTS_SQL")
   printf 'TARGET_BASELINE_DIGEST=%s\n' "$TARGET_BASELINE_DIGEST"
   ```

   Stop unless `TARGET_BASELINE_DIGEST` is a 64-character hash. The identity probe's probe table must already be removed
   (its verification is in _Identity probe_), so the baseline contains only the restored data.

3. Store the current production `DATABASE_URL` value in the password manager (the value, not in a file or a ticket), so the
   old target can be restored in one step.

4. Update the existing Vercel production variable and create the production deployment **without assigning the production
   domain** (`--skip-domain`). The public domain keeps its current deployment until step 6. The value comes from stdin, never
   from argv. **From this command on the target counts as exposed, whatever the result of the update or of the deployment**,
   so rollback follows the exposed path in _Rollback_. While any status below is nonzero, the target barrier stays closed.

   ```sh
   printf '%s' "$CUTOVER_URL" | vercel env update DATABASE_URL production --yes
   UPDATE_STATUS=$?
   DEPLOY_STATUS=1
   DEPLOY_URL=''
   if [ "$UPDATE_STATUS" -eq 0 ]; then
     DEPLOY_URL=$(vercel deploy --prod --skip-domain | tail -n 1) && DEPLOY_STATUS=0
   fi
   printf 'env update: %s; deploy: %s\n' "$UPDATE_STATUS" "$DEPLOY_STATUS"
   ```

   Confirm that the installed CLI supports `--skip-domain` (`vercel deploy --help`) before the switch. In the dashboard the
   same two results are needed, and the deployment must be created without assigning the production domain; otherwise the
   routing proof in step 5 does not stand. Do not add a Preview or Development entry.

5. **Routing proof before the domain moves.** Writers are still closed. Send a read-only `GET` of the test list to
   `DEPLOY_URL`. Do not sign in and do not write. Pass only when the target shows a session of `<runtime-role>` opened by
   that request (the sessions query with `datname` of the target, read as the owner role with `pg_read_all_stats`), the old
   database shows no session from the site, and the runtime error view in Vercel for that deployment is clean.

6. **Move the production domain to that deployment**, with the operator's documented alias command (confirm it with
   `vercel alias --help` before the switch), and repeat the routing proof on the **production domain**: `vercel inspect`
   (or the dashboard) shows `DEPLOY_URL` as the production alias, a read-only `GET` of the test list succeeds, the target
   shows a session of `<runtime-role>`, and the old database shows no session from the site.

7. **Reopen the target** only when `env update: 0; deploy: 0`, the routing proofs of steps 5 and 6 both passed, and the
   target reopen block of _Write barrier_ reopens it, printing `target barrier: reopened, grants identical`. Only after that line
   does the operator sign in and read a test list as a smoke test; sign-in is a write, so it is not part of any routing
   proof. A nonzero status or a failed proof keeps the cutover held. The target reopen block of _Write barrier_ (run once)
   either prints `target barrier: reopened, grants identical`, or it closes the barrier again and prints
   `barrier target: closed`. If neither line prints, the target barrier state is unknown: writers stay stopped, and only
   `close_only_target` is run, again and again if needed, until `barrier target: closed` prints. The reopen block is not
   run again, and nothing else is done before that line.

8. Record the selected copy or time, the target name (not its URL), the checks that passed, the decision used, `FROZEN_AT`,
   the switch time, the parent of the branch and the deployment identifier (not its URL), without credentials. The old
   database stays fenced and its barrier stays closed after the switch.

#### Rollback

Rollback is decided by the content of the target, never by its statistics. `WRITE_COUNTER_SQL`, the sequence positions
and `count(*)` can all stay equal after a write: a single-field `UPDATE` of an existing row changes no count and no
sequence, and the statistics behind the write counter are published with a delay. The content digest changes when the
content of any row changes, so it is the evidence. It cannot see a write that was made and undone before the check, which
is why the path is chosen by **exposure**, recorded in the ticket before anything is changed.

**Before exposure** (no `vercel env update` has been run). Production still uses the old URL, so nothing is restored in
Vercel. The simplest safe rollback is to abandon the switch and reopen the old database only after all of these hold:

- the target's digest equals `TARGET_BASELINE_DIGEST`, as the owner role (nothing reached the target):

  ```sh
  load_libpq_env "$TARGET_URL"
  same_digest "$TARGET_BASELINE_DIGEST" "$(checked_digest "$ROWHASH_SQL" psql_stdin)" && echo "target digest: unchanged"
  ```

- the old database's digest equals `PRE_STOP_DIGEST`, its identity SHA-256 equals `PRE_STOP_IDENTITY_SHA`, and it has no
  session other than the operator's and the verifier's; both are read through `prod_ro` as in _Fence production_:

  ```sh
  same_digest "$PRE_STOP_DIGEST" "$(checked_digest "$ROWHASH_SQL" prod_ro psql_stdin)" && echo "old digest: unchanged"
  same_digest "$PRE_STOP_IDENTITY_SHA" "$(checked_digest "$IDENTITY_SQL" prod_ro psql_stdin)" && echo "old identity: unchanged"
  ```

- the runtime role connects to the old database and returns the row of the runtime-role check.

Then run the production reopen block of _Write barrier_ (once; it prints `production barrier: reopened, grants identical`
on success) and restore writers in the reverse order of the fence, recording the time. The target barrier stays
closed: the target was abandoned before any traffic reached it. Any difference means a write may have reached the target or
got past the fence: the path is then ambiguous, and the exposed path applies.

**Exposed or ambiguous** (once `vercel env update` has been run, whatever its result, or once any check above differs).
There is **no automatic rollback** on this path: restoring the old URL would silently drop what was written to the target.
Required steps:

1. **Fence the target again.** Run `close_only_target` on every entry to exposed rollback. Proceed only after this
   invocation prints `barrier target: closed` (_Write barrier_). Earlier confirmations cannot be reused. Stop the writers of every deployment that holds the target URL by the methods of _Fence
   production_ step 1, and confirm that no deployment still serves requests or runs scheduled work with it. Terminate target
   sessions other than the operator's and the verifier's (`pg_terminate_backend` rolls back their open transactions only),
   then run the session and write-role checks, and `BARRIER_CHECK_SQL` on the target, twice, two minutes apart, as in
   _Fence production_ step 2.
2. **Compare the two databases** with _Post-point changes_ in the opposite direction: the target is now the source of the
   changes and the old database the destination. Write the decision (reconcile or accept loss) in the ticket, as for the
   switch. Reconciliation applies the target's rows to the old database as the owner role.
3. **Verify the old database independently**, from a fresh session with a second operator reading the outputs. Its
   `ROWHASH` digest must equal the target's digest (after reconciliation), its identity SHA-256 must equal
   `PRE_STOP_IDENTITY_SHA`, its sessions must be only the operator's and the verifier's, and the runtime role must return
   its row. Its write barrier stays closed while this is done.
4. Only then put the old URL back, and prove routing before and after the domain moves. Writers of the old database stay
   closed:

   ```sh
   printf 'Old production URL (not echoed): '
   read -rs OLD_URL
   echo
   printf '%s' "$OLD_URL" | vercel env update DATABASE_URL production --yes
   UPDATE_STATUS=$?
   unset OLD_URL
   DEPLOY_STATUS=1
   DEPLOY_URL=''
   if [ "$UPDATE_STATUS" -eq 0 ]; then
     DEPLOY_URL=$(vercel deploy --prod --skip-domain | tail -n 1) && DEPLOY_STATUS=0
   fi
   printf 'env update: %s; deploy: %s\n' "$UPDATE_STATUS" "$DEPLOY_STATUS"
   ```

   Proof before the domain moves: a read-only `GET` of the test list to `DEPLOY_URL` opens a session of `<runtime-role>` on
   the **old** database, and the target shows no session from the site. Then move the production domain as in _Switch_
   step 6, and repeat the same proof on the production domain.

5. **Reopen the old database only when** `env update: 0; deploy: 0`, both proofs passed, and the production reopen block of
   _Write barrier_ (run once) printed `production barrier: reopened, grants identical`. Then reopen writers one at a time in
   the reverse order of the fence, re-checking each. A nonzero status or a failed proof keeps every writer stopped. The
   production reopen block either prints `production barrier: reopened, grants identical`, or it closes the old database
   again and prints `barrier production: closed`. If neither line prints, its state is unknown: only `close_only_production`
   is run, until `barrier production: closed` prints; the reopen block is not run again. The target stays fenced and is kept
   for the ticket.

Do not mark or delete the old target while a rollback is still possible. If any step fails, keep the old setting and
investigate before any further change. Finally, unset the variables and remove temporary targets and files when they are no
longer needed. A directory is removed only when this attempt created it: `remove_own_dir` refuses any other path, a link, a
directory the operator does not own, and any directory whose `.recovery-owned` marker does not hold this attempt's `RUN_ID`.
A directory of an earlier attempt, including a point-in-time directory with a valid marker from that attempt, is refused and
kept. Directories of a failed or refused step are kept as evidence until the ticket records them; they are removed only by
this step.

```sh
# remove_own_dir DIR: removes DIR only when this attempt created it: a real directory owned by the operator, not a link,
# whose marker holds this attempt's RUN_ID. Another attempt's directory, an unmarked one, or an unset RUN_ID is refused.
remove_own_dir() {
  [ -n "${RUN_ID:-}" ] && [ -n "${1:-}" ] && [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] \
    && [ "$(cat -- "$1/.recovery-owned" 2>/dev/null)" = "$RUN_ID" ] \
    || { echo "remove_own_dir: refused $1" >&2; return 1; }
  rm -rf -- "$1"
}
unset TARGET_URL CUTOVER_URL PROD_READONLY_URL PROD_OWNER_URL OLD_URL RECOVERY_TIME RESTORE_DB AGE_IDENTITY PROBE_NONCE RUNTIME_NONCE
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGCHANNELBINDING PGOPTIONS
# Each scratch path is removed only if this attempt set it; an empty path (the encrypted-only route never sets RECOVERY_DIR)
# is skipped, and a refused path is kept and reported.
for _scratch in "${DIFF_DIR:-}" "${EXP_DIR:-}" "${RECOVERY_DIR:-}"; do
  [ -z "$_scratch" ] || remove_own_dir "$_scratch" || echo "kept for the ticket: $_scratch" >&2
done
unset _scratch RUN_ID
```

Retain the selected encrypted copy, and the ticket's records, according to policy.

#### Recovery drill and cutover dry run

Quarterly and before the first users, use the latest verified encrypted copy and the commands above (_Create the target_
step 2, or step 3 outside Neon, then the empty-target check, the restore, _Verify the encrypted copy_, and the runtime-role check) against a fresh empty
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
- **Single-field update control:** on the synthetic target, one field of one existing row is updated, with no insert or
  delete. `COUNTS_SQL` and `SEQUENCE_SQL` stay equal to their baseline, and the `ROWHASH` digest no longer equals
  `TARGET_BASELINE_DIGEST`. The drill fails if the digest does not change. This is the control that shows the counters
  are not rollback evidence.
- the rollback path chosen after a switch attempt is the exposed path: the drill checks that it refuses automatic
  rollback, and that the pre-exposure check fails when the target digest differs from its baseline.
- a restore-ready result is reached on a target at another provider with no Neon CLI or Neon branch in the session.
- with the old source made unreachable (or its reads refused), the switch is held: no `vercel env update` runs, the target
  stays restore-ready, and the hold is recorded.
- a point-in-time branch whose read-back shows another parent, or another instant for `parent_timestamp`, is refused and
  **nothing is deleted**: the drill checks that the candidate id is recorded and that no deletion runs. Any later removal
  is a separate operator action by that exact id, after the operator confirms it belongs to this run, never by name. The
  same instant written in another form (for example `+00:00` or extra zeros in the fraction) passes.
- a different cluster with the same database name, roles and migrations fails the identity probe: its
  `system_identifier` differs and the owner's nonce does not read back through its runtime URL. The same cluster passes.
  The schema digest is equal on both clusters, so it is not used as identity.
- a read that prints rows and then fails (for example `SELECT 'partial'; SELECT 1/0;`), or that prints nothing, is
  rejected by `checked_digest`. A repeated full read reproduces the earlier digest exactly.
- after an exposed rollback with a failed `vercel env update` or a failed `vercel deploy --prod`, every writer stays
  stopped. The drill checks that writers reopen only after the routing check passes.
- **Write barrier, both databases.** The production and target barriers print `closed` only when `BARRIER_CHECK_SQL`
  returns no row. As the runtime role, a write (INSERT, UPDATE, DELETE, TRUNCATE, nextval) fails with `permission denied`
  and a read succeeds. Reopening prints `reopened, grants identical`. A write that reaches the runtime role through `PUBLIC`
  or a role membership makes the close unconfirmed, and the cutover is held.
- **Negative dry run, both directions.** A drill runs no Vercel command. Its inputs are a successful `env update` and
  `deploy` (recorded as such) and a routing proof that fails: the domain still on another deployment, or the deployment
  reading the other database. The target barrier then stays closed and a runtime write to the target is denied, with no
  reopen line produced. In the rollback direction the old database stays closed and a runtime write to it is denied. The
  drill records which proof failed.
- **Post-point comparison under failure.** `compare_post_point` is run with a target read that prints rows and then exits
  nonzero, with a target read that exits nonzero with full output, with an empty target read, with a failed target load,
  with a failed sort, a failed `comm`, a missing or behind sequence, and with `cmp-*` artifacts left in the same `DIFF_DIR`
  by an earlier successful run. Each failure prints no comparison result and holds the cutover; a complete run prints
  `post-point comparison: complete`.
- **Sequence and final read.** `compare_post_point` is run with: a target sequence missing; a target sequence behind
  production; a target with no sequences while production has some (this must fail: it is the case an `NR == FNR` test
  gets wrong); a sequence read that prints rows and then fails, or prints rows without the completion line; a sequence
  baseline whose read failed (`SEQ_BASELINE` unset); and a report that cannot be read back (`cmp-report.txt` with mode
  `000`, as a non-root user). Each prints no `post-point comparison: complete`. A database with no sequences on both
  sides passes. A production sequence that was never called, against a target value, passes; a target sequence that was
  never called, against a production value, is `behind`.
- **Sequence unreadable to the role.** `SEQUENCE_SQL` is run as a role with no SELECT or USAGE on one sequence of a database
  that has a value for it, and as a role that can read it. The first shows an `unknown` line, the completion line's counts
  differ, `sequence_read_ok` fails, and `SEQ_BASELINE` stays unset. The second passes and shows that sequence's value.
  A never-called sequence reads as `never-called` and passes for the role that can read it.
- **Reopen refused, both directions.** `reopen_barrier` is run with an injected mismatch (one line of the snapshot changed)
  and with an injected failure (an error in the saved open file). Each prints no `reopened` line, `reclose_barrier` prints
  `barrier ...: closed`, the runtime role's write privilege stays absent, and an `INSERT` into a table of that database as
  the runtime role returns `permission denied`. The same call with an unchanged snapshot commits, and the independent read
  prints `reopened, grants identical`.
- **Reopen with a lost COMMIT acknowledgement.** The generated reopen file gets `SELECT pg_terminate_backend(pg_backend_pid());`
  right after its `COMMIT;`, so the server commits and the client sees a dropped connection. The block prints no `reopened`
  line, and before the reclose the runtime role's `INSERT` is `allowed`, which shows the barrier was open. `reclose_barrier`
  then prints `barrier ...: closed` and the `INSERT` is `permission denied`.
- **Reopen with a failed independent read.** The reopen commits, then only its first independent read fails. Restore the verifier
  before the reclose check. If the verifier is still unavailable, record the state as unknown and retry only close-only. The block prints no `reopened` line, the barrier is closed again (`barrier production: closed`), and
  the runtime role's `INSERT` is `permission denied`.
- **Close-only retry after a failed post-read, both directions.** For each database in turn (production first, then
  target): the reopen block runs with its post-read made to fail (production: the one-shot read failure above;
  target: `GRANTS_SQL` replaced by `SELECT 1/0;` for that one read). The block prints no `reopened` line and then
  `barrier LABEL: closed`. Then, with the failure removed and **without running any reopen block**, `close_only_LABEL` is run.
  The control records: its output has no `reopened` line; `type close_only_LABEL` lists only `close_file_ok` and
  `reclose_barrier`; SHA-256 of the saved open file and of the pre-barrier snapshot are unchanged across the retry; the
  runtime role's `INSERT` is `permission denied` before and after; and the retry prints `barrier LABEL: closed`.
- **Exposed rollback after a successful reopen.** Close the target and record the initial confirmation, reopen it,
  and verify a fixture runtime write succeeds. Enter exposed rollback and run `close_only_target` again. Require a fresh
  confirmation and a denied fixture runtime write before any reverse comparison.
- **Close-only retry after the first failed reclose, both directions.** After a reopen commits, the close file of that
  database is replaced by a copy that fails (`SELECT 1/0;`) for one reclose. The reclose prints no `barrier LABEL: closed`,
  the runtime role's `INSERT` is `allowed` (the barrier is open), and the writers of that database are recorded as stopped.
  The original close file is then restored from its recorded SHA-256, and only `close_only_LABEL` is run. The control
  records that it prints `barrier LABEL: closed` only after its own check, that the `INSERT` is then `permission denied`,
  that the reopen block was not run a second time, and that the snapshot files are unchanged. A second run of
  `close_only_LABEL` is idempotent: it prints `barrier LABEL: closed` again and grants nothing.
- **Close file with a GRANT.** A close file containing a `GRANT` line is refused by `close_only_LABEL` before any `psql`
  call, and the barrier state is unchanged.
- **Inherited DIFF_DIR.** With `DIFF_DIR` set to a directory holding a sentinel file, the directory block creates a new
  `recovery-diff-` directory, `DIFF_DIR` names the new one, the sentinel is unchanged, and `remove_own_dir` refuses the
  sentinel directory (no marker).
- **Previous point-in-time scratch survives an encrypted-only cleanup.** A `recovery-branch-` directory with a valid marker
  holding a different (earlier) `RUN_ID`, and a sentinel file, is left in place. A new shell runs _Shell and prerequisites_
  (new `RUN_ID`), the encrypted-only route, and the final cleanup. `remove_own_dir` refuses the directory with
  `remove_own_dir: refused`, and the sentinel is unchanged.
- **Inherited RECOVERY_DIR in the same shell.** With `RECOVERY_DIR` set to that same directory in a shell, the run-start block
  of _Shell and prerequisites_ runs first. It resets `RECOVERY_DIR` to empty, so the cleanup never names the directory; the
  sentinel is unchanged. The marker check is the independent second guard: a directory of an earlier `RUN_ID` is refused
  even if its path is named again.
- **One directory.** A clean shell runs the production close, the fence and the post-point comparison in the order written,
  with one `DIFF_DIR` created once; the production reopen then compares with the snapshot taken before the close.

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
- Primary catalog image audit: `vercel env run -e production -- npm run audit:catalog-images` (read-only DB check + actual HTTP `GET` image verification within bounded time/bytes, rejecting non-200, `HEAD`/`GET` mismatches, and non-image/HTML payloads; prints only item names, HTTP/status codes, and aggregate counts)
- Primary catalog image repair: `vercel env run -e production -- npm run db:repair-catalog-images -- --plan <plan.json>` (dry-run by default; validates replacement URLs against the storefront `next.config.ts` `remotePatterns` contract before HTTP/DB, requires proven `404`/`410` absence on old URLs and `GET` 200 image bytes on new URLs, and treats `429`/`503`/ambiguous states as `UNKNOWN`; add `--apply` for atomic `Serializable` update)

### Primary catalog image audit and repair (AGE-1667)

1. **Pre-check & encrypted backup (before any write):**
   - Run the read-only HTTP audit from a clean checkout without `.env`:
     `vercel env run -e production -- npm run audit:catalog-images`
   - Record before-counts (`checked`, `ok_200`, `failed`, `emoji_only`) and the failing item names.
   - Take a verified encrypted production backup (`npm run db:backup:verified` / direct unpooled URL per _Database_ and _Production recovery_ above). Never store production dumps in Git or GitHub.
2. **Dry-run & atomic apply (only with proven `old -> new` pairs):**
   - Prepare a local `--plan <plan.json>` outside the repository containing only proven `{ target, category, name, expectedImageUrl, expectedIsCustom, newImageUrl }` entries (never commit production URLs or plans to Git). Every `newImageUrl` must match the storefront `next.config.ts` `images.remotePatterns` contract (`https://utfs.io/f/*` or `https://3kv5vvupx6.ufs.sh/f/*`).
   - Run dry-run first (validates storefront URL contract, checks live CDN `HEAD`+`GET` status/image bytes, and verifies read-only DB preconditions):
     `vercel env run -e production -- npm run db:repair-catalog-images -- --plan /path/to/repair-plan.json`
   - Stop on any conflict, disallowed replacement URL, non-image/mismatched `GET` on new URL, still-200 old URL, or `UNKNOWN` old-URL status (`429`/`503`/timeout/mismatch).
   - Apply inside one `Serializable` transaction (conditional `updateMany` on `expectedImageUrl` and `expectedIsCustom`; aborts and rolls back all changes if any concurrent edit occurs):
     `vercel env run -e production -- npm run db:repair-catalog-images -- --plan /path/to/repair-plan.json --apply`
3. **Post-check & safe rollback:**
   - Re-run `vercel env run -e production -- npm run audit:catalog-images` and confirm `failed=0` (`exit 0`).
   - **Rollback:** Do **not** re-run `repair-catalog-images` with reversed URLs: the script rejects both `newImageUrl` when the old URL returns `404`/`410` and `expectedImageUrl` when the repaired URL now returns `200`. Rollback commands do not rely on HTTP CDN probes: restore from the pre-repair backup using _Production recovery_ (new target, verification, write barrier, cutover) or execute a coordinator-approved conditional SQL `UPDATE` matching `newImageUrl` back to the saved pre-repair values in a single transaction, then re-verify counts with `audit:catalog-images`.

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
