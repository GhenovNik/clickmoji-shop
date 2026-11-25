-- Additive only: nullable columns, no default, no rewrite. The previous application release
-- does not select them, so it keeps working before and after this migration.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- AlterTable
ALTER TABLE "products" ADD COLUMN "imageTextLocale" TEXT,
ADD COLUMN "localizedImages" JSONB;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN "imageTextLocale" TEXT,
ADD COLUMN "localizedImages" JSONB;

-- AlterTable
ALTER TABLE "list_history_items" ADD COLUMN "imageTextLocale" TEXT,
ADD COLUMN "localizedImages" JSONB;

COMMIT;
