-- AlterTable
ALTER TABLE "list_history_items" ADD COLUMN     "categoryNameEn" TEXT,
ADD COLUMN     "productImageUrlEn" TEXT,
ADD COLUMN     "productNameEn" TEXT,
ADD COLUMN     "variantNameEn" TEXT;

-- Backfill: past snapshots take the English names and picture of the product, category and
-- variant they still point at. Rows whose product is gone keep null and show the Russian copy.
UPDATE "list_history_items" AS h
SET "productNameEn" = p."nameEn",
    "productImageUrlEn" = p."imageUrlEn",
    "categoryNameEn" = c."nameEn"
FROM "products" AS p
JOIN "categories" AS c ON c."id" = p."categoryId"
WHERE h."productId" = p."id";

UPDATE "list_history_items" AS h
SET "variantNameEn" = v."nameEn"
FROM "product_variants" AS v
WHERE h."variantId" = v."id";
