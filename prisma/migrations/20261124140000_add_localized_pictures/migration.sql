-- Additive only: nullable columns, no default, no rewrite. The previous application release
-- does not select them, so it keeps working before and after this migration.
-- AlterTable
ALTER TABLE "products" ADD COLUMN "imageTextLocale" TEXT,
ADD COLUMN "localizedImages" JSONB;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN "imageTextLocale" TEXT,
ADD COLUMN "localizedImages" JSONB;

-- AlterTable
ALTER TABLE "list_history_items" ADD COLUMN "imageTextLocale" TEXT,
ADD COLUMN "localizedImages" JSONB;
