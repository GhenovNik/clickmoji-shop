-- Snapshot names, pictures and other history fields remain untouched. Only optional live IDs
-- that already point nowhere are cleared before adding permanent reference integrity.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE products, product_variants, list_history_items IN SHARE ROW EXCLUSIVE MODE;

UPDATE "list_history_items" h SET "productId" = NULL
WHERE h."productId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p.id = h."productId");
UPDATE "list_history_items" h SET "variantId" = NULL
WHERE h."variantId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "product_variants" v WHERE v.id = h."variantId");

CREATE INDEX "list_history_items_productId_idx" ON "list_history_items"("productId");
CREATE INDEX "list_history_items_variantId_idx" ON "list_history_items"("variantId");

ALTER TABLE "list_history_items" ADD CONSTRAINT "list_history_items_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "list_history_items" ADD CONSTRAINT "list_history_items_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;
