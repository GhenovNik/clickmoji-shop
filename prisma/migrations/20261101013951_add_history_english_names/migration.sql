-- AlterTable
ALTER TABLE "list_history_items" ADD COLUMN     "categoryNameEn" TEXT,
ADD COLUMN     "productImageUrlEn" TEXT,
ADD COLUMN     "productNameEn" TEXT,
ADD COLUMN     "variantNameEn" TEXT;

-- No backfill: a past snapshot keeps exactly what was recorded then. Filling it from today's
-- catalogue would show renamed, moved or re-pictured products in English only. Old rows keep null
-- and the English interface falls back to their Russian copy; new snapshots record both.
