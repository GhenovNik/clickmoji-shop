-- DropIndex
DROP INDEX IF EXISTS "items_listId_productId_variantId_key";

-- CreateIndex
CREATE UNIQUE INDEX "items_listId_productId_key" ON "items"("listId", "productId");
