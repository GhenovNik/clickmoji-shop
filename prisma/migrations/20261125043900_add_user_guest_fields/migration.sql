-- Additive only: adds server guest account marker (constant default false, metadata-only on PG 11+)
-- and nullable guest activity timestamp on users, plus a supporting index for guest-only inactivity cutoff.
-- Statements stay outside an explicit BEGIN/COMMIT so Prisma 7 can record a failed-migration receipt cleanly
-- on the same connection if a bounded lock wait (55P03) triggers; IF NOT EXISTS keeps retries idempotent.
SET lock_timeout = '5s';
SET statement_timeout = '15s';

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "isGuest" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "guestLastActiveAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_isGuest_guestLastActiveAt_idx"
  ON "users"("isGuest", "guestLastActiveAt");

RESET lock_timeout;
RESET statement_timeout;
