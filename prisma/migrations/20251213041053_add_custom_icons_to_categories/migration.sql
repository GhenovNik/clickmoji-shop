-- DropIndex
DROP INDEX "products_name_en_trgm_idx";

-- DropIndex
DROP INDEX "products_name_trgm_idx";

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "isCustom" BOOLEAN NOT NULL DEFAULT false;
