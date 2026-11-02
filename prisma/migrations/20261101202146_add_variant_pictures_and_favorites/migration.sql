-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "imageUrlEn" TEXT;

-- CreateTable
CREATE TABLE "variant_favorites" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "variant_favorites_userId_idx" ON "variant_favorites"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "variant_favorites_userId_variantId_key" ON "variant_favorites"("userId", "variantId");

-- AddForeignKey
ALTER TABLE "variant_favorites" ADD CONSTRAINT "variant_favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_favorites" ADD CONSTRAINT "variant_favorites_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

