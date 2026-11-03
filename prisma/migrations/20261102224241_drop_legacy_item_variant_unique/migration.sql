-- Repair databases where the legacy variant uniqueness survived earlier migrations.
-- Shopping rows intentionally allow duplicate products/variants (separate notes/items).
DROP INDEX IF EXISTS "items_listId_productId_variantId_key";
