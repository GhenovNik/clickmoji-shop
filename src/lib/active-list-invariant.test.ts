import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const activeListMigrationPath = path.join(
  process.cwd(),
  'prisma/migrations/20260627000000_unique_active_list_per_user/migration.sql'
);

describe('active list database invariant migration', () => {
  it('normalizes duplicate active lists before adding a partial unique index', () => {
    expect(existsSync(activeListMigrationPath)).toBe(true);

    const migrationSql = readFileSync(activeListMigrationPath, 'utf8');

    expect(migrationSql).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(/i);
    expect(migrationSql).toMatch(/PARTITION BY "userId"/i);
    expect(migrationSql).toMatch(/UPDATE "lists"\s+SET "isActive" = false/i);
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "lists_one_active_per_user_idx"\s+ON "lists" \("userId"\)\s+WHERE "isActive" = true/i
    );
  });
});
