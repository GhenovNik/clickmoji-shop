// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261102224241_drop_legacy_item_variant_unique/migration.sql',
  'utf8'
);

describe('legacy Item index repair lock policy', () => {
  it('bounds lock wait before DROP and resets the migration session policy', () => {
    expect(sql).toMatch(
      /SET lock_timeout\s*=\s*'5s'\s*;[\s\S]*DROP INDEX IF EXISTS\s+"items_listId_productId_variantId_key"\s*;[\s\S]*RESET lock_timeout\s*;/i
    );
  });
  it('also bounds statement execution without leaking session settings', () => {
    expect(sql).toMatch(
      /SET statement_timeout\s*=\s*'15s'\s*;[\s\S]*DROP INDEX[\s\S]*RESET statement_timeout\s*;/i
    );
    expect(sql).not.toMatch(/DROP INDEX CONCURRENTLY/i);
  });
});
