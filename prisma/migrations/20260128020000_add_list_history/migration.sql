-- CreateTable
CREATE TABLE "list_histories" (
    "id" TEXT NOT NULL,
    "listName" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "listId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "list_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "list_history_items" (
    "id" TEXT NOT NULL,
    "historyId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "productName" TEXT NOT NULL,
    "productEmoji" TEXT NOT NULL,
    "productImageUrl" TEXT,
    "categoryName" TEXT NOT NULL,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "variantName" TEXT,
    "variantEmoji" TEXT,
    "note" TEXT,
    "isPurchased" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "list_history_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "list_histories_userId_idx" ON "list_histories"("userId");

-- CreateIndex
CREATE INDEX "list_histories_listId_idx" ON "list_histories"("listId");

-- CreateIndex
CREATE INDEX "list_history_items_historyId_idx" ON "list_history_items"("historyId");

-- AddForeignKey
ALTER TABLE "list_histories" ADD CONSTRAINT "list_histories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_histories" ADD CONSTRAINT "list_histories_listId_fkey" FOREIGN KEY ("listId") REFERENCES "lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_history_items" ADD CONSTRAINT "list_history_items_historyId_fkey" FOREIGN KEY ("historyId") REFERENCES "list_histories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
