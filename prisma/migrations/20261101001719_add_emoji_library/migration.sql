-- CreateTable
CREATE TABLE "emoji_library_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageUrl" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emoji_library_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "emoji_library_items_imageUrl_key" ON "emoji_library_items"("imageUrl");

-- CreateIndex
CREATE UNIQUE INDEX "emoji_library_items_sourceRef_key" ON "emoji_library_items"("sourceRef");

-- CreateIndex
CREATE INDEX "emoji_library_items_name_idx" ON "emoji_library_items"("name");
