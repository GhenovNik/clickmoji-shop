-- Add private-product ownership fields used by smart-create and product visibility filters
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "createdProductsCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "isGlobal" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "createdById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_createdById_fkey'
  ) THEN
    ALTER TABLE "products"
      ADD CONSTRAINT "products_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
