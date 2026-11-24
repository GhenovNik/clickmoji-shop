-- CreateTable
CREATE TABLE "ai_monthly_budgets" (
    "monthStart" TIMESTAMP(3) NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_monthly_budgets_pkey" PRIMARY KEY ("monthStart"),
    CONSTRAINT "ai_monthly_budgets_non_negative" CHECK ("reservedMicroUsd" >= 0 AND "spentMicroUsd" >= 0)
);
