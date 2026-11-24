-- CreateEnum
CREATE TYPE "FunnelEventType" AS ENUM ('VISIT', 'REGISTER', 'LOGIN', 'LIST_CREATE', 'ITEM_ADD', 'ITEM_PURCHASE');

-- CreateTable
CREATE TABLE "funnel_events" (
    "id" TEXT NOT NULL,
    "type" "FunnelEventType" NOT NULL,
    "guestId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funnel_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "funnel_events_createdAt_idx" ON "funnel_events"("createdAt");

-- CreateIndex
CREATE INDEX "funnel_events_type_createdAt_idx" ON "funnel_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "funnel_events_userId_createdAt_idx" ON "funnel_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "funnel_events_guestId_createdAt_idx" ON "funnel_events"("guestId", "createdAt");

-- AddForeignKey
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
