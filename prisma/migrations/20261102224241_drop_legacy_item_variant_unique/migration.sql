-- Repair databases where the legacy variant uniqueness survived earlier migrations.
-- Shopping rows intentionally allow duplicate products/variants (separate notes/items).
-- The installed Prisma engine executes statements without an explicit transaction.
-- SET bounds this dedicated migration connection. On success RESET avoids leaking
-- policy to later migrations; on failure migrate exits and closes the connection.
-- Avoid explicit BEGIN: an aborted transaction can mask the original lock error
-- when Prisma tries to record its failed-migration receipt on that connection.
SET lock_timeout = '5s';
SET statement_timeout = '15s';
DROP INDEX IF EXISTS "items_listId_productId_variantId_key";
RESET lock_timeout;
RESET statement_timeout;
