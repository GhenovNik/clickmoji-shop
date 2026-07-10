-- Keep the oldest active list per user before enforcing the database invariant.
WITH ranked_active_lists AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS active_rank
  FROM "lists"
  WHERE "isActive" = true
)
UPDATE "lists"
SET "isActive" = false
WHERE "id" IN (
  SELECT "id"
  FROM ranked_active_lists
  WHERE active_rank > 1
);

CREATE UNIQUE INDEX "lists_one_active_per_user_idx"
ON "lists" ("userId")
WHERE "isActive" = true;
