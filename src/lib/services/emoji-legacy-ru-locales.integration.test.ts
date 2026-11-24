// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaPgAdapter } from '../prisma-adapter';
import {
  DEFAULT_CANDIDATES_PATH,
  DEFAULT_MANIFEST_PATH,
  loadLegacyRussianTargets,
} from './emoji-legacy-ru-locales';

// Run only through npm run test:legacy-locales-postgres: it creates and removes its own Docker DB.
const url = process.env.INTEGRATION_DATABASE_URL;
const REPO_ROOT = process.cwd();
const CLI_PATH = resolve(REPO_ROOT, 'scripts/emoji-legacy-ru-locales.ts');
const TSX_CLI = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[], opts: { databaseUrl?: string; cwd?: string } = {}) {
  const env = { ...process.env };
  if (opts.databaseUrl === undefined) {
    delete env.DATABASE_URL;
  } else {
    env.DATABASE_URL = opts.databaseUrl;
  }
  return spawnSync(process.execPath, [TSX_CLI, CLI_PATH, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe.skipIf(!url)('legacy Russian image locales CLI on disposable PostgreSQL', () => {
  let db: PrismaClient;
  const targets = loadLegacyRussianTargets();

  beforeAll(() => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/legacy_locales_test') {
      throw new Error('This destructive fixture requires the Docker test runner database');
    }
    db = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE emoji_library_items RESTART IDENTITY CASCADE`;
  });

  async function seedSyntheticLibrary() {
    // 11 legacy batch-NNN pictures initially imported with locale=null.
    // Includes:
    //   - index 0 (batch-001#3): paired via :en twin with custom groupKey ("custom-almond-group") while ru has null groupKey
    //   - index 1 (batch-005#3): paired via :en twin where BOTH ru and en have missing groupKey (null)
    //   - index 2 (batch-005#4): paired via shared groupKey ("legacy-ryazhenka") with en.sourceRef=null
    //   - index 3 (batch-005#5): unpaired with groupKey=null
    //   - indices 4..10: unpaired with groupKey=sourceRef (standard 24.11 import state)
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      const groupKey =
        i === 0 || i === 1 || i === 3 ? null : i === 2 ? 'legacy-ryazhenka' : target.ref;

      await db.emojiLibraryItem.create({
        data: {
          id: `ru-${i}`,
          name: target.name,
          nameEn: target.nameEn,
          tags: [target.category.toLowerCase()],
          imageUrl: `https://example.invalid/emoji/${target.batch}-${target.cell}.webp`,
          source: 'batch',
          sourceRef: target.ref,
          locale: null,
          groupKey,
        },
      });
    }

    // English twins for indices 0, 1, 2
    await db.emojiLibraryItem.create({
      data: {
        id: 'en-0',
        name: targets[0]!.name,
        nameEn: targets[0]!.nameEn,
        tags: [targets[0]!.category.toLowerCase()],
        imageUrl: 'https://example.invalid/emoji/batch-001-3-en.webp',
        source: 'batch',
        sourceRef: `${targets[0]!.ref}:en`,
        locale: 'en',
        groupKey: 'custom-almond-group',
      },
    });
    await db.emojiLibraryItem.create({
      data: {
        id: 'en-1',
        name: targets[1]!.name,
        nameEn: targets[1]!.nameEn,
        tags: [targets[1]!.category.toLowerCase()],
        imageUrl: 'https://example.invalid/emoji/batch-005-3-en.webp',
        source: 'batch',
        sourceRef: `${targets[1]!.ref}:en`,
        locale: 'en',
        groupKey: null,
      },
    });
    await db.emojiLibraryItem.create({
      data: {
        id: 'en-2',
        name: targets[2]!.name,
        nameEn: targets[2]!.nameEn,
        tags: [targets[2]!.category.toLowerCase()],
        imageUrl: 'https://example.invalid/emoji/batch-005-4-en.webp',
        source: 'upload',
        sourceRef: null,
        locale: 'en',
        groupKey: 'legacy-ryazhenka',
      },
    });

    // Non-target rows that must remain completely untouched
    await db.emojiLibraryItem.createMany({
      data: [
        {
          id: 'other-universal',
          name: 'Розмарин',
          nameEn: 'Rosemary',
          tags: ['овощи'],
          imageUrl: 'https://example.invalid/emoji/batch-002-1.webp',
          source: 'batch',
          sourceRef: 'batch-002#1',
          locale: null,
          groupKey: 'batch-002#1',
        },
        {
          id: 'other-text-ru',
          name: targets[0]!.name,
          nameEn: targets[0]!.nameEn,
          tags: ['орехи и сухофрукты'],
          imageUrl: 'https://example.invalid/emoji/text-001-1.webp',
          source: 'batch',
          sourceRef: 'text-001#1',
          locale: 'ru',
          groupKey: 'text-001#1',
        },
        {
          id: 'other-text-en',
          name: targets[0]!.name,
          nameEn: targets[0]!.nameEn,
          tags: ['орехи и сухофрукты'],
          imageUrl: 'https://example.invalid/emoji/text-001-1-en.webp',
          source: 'batch',
          sourceRef: 'text-001#1:en',
          locale: 'en',
          groupKey: 'text-001#1',
        },
        {
          id: 'other-upload',
          name: 'Пользовательская',
          nameEn: 'Custom',
          tags: [],
          imageUrl: 'https://example.invalid/emoji/custom.webp',
          source: 'upload',
          sourceRef: null,
          locale: null,
          groupKey: null,
        },
      ],
    });
  }

  it('ignores .env when DATABASE_URL is absent from inherited environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-ru-dotenv-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, '.env'), `DATABASE_URL="${url}"\n`);

    const res = runCli(
      [
        '--manifest',
        resolve(REPO_ROOT, 'docs/emoji-batches/manifest.json'),
        '--candidates',
        resolve(REPO_ROOT, 'docs/emoji-batches/candidates.json'),
      ],
      { cwd: dir }
    );

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('DATABASE_URL is not set in the environment');
  });

  it('rejects incomplete override manifests before writing to PostgreSQL even with valid DATABASE_URL', async () => {
    await seedSyntheticLibrary();
    const snapshotBefore = await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } });

    const dir = mkdtempSync(join(tmpdir(), 'legacy-ru-scope-'));
    tempDirs.push(dir);
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, DEFAULT_MANIFEST_PATH), 'utf8')
    ) as Array<{ kind?: string; cells: Array<{ supersededBy?: string }> }>;
    for (let i = manifest.length - 1; i >= 0; i--) {
      const batch = manifest[i]!;
      if (batch.kind === 'text') continue;
      const idx = batch.cells.findIndex((cell) => Boolean(cell.supersededBy));
      if (idx !== -1) {
        batch.cells.splice(idx, 1);
        break;
      }
    }
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const res = runCli(
      [
        '--apply',
        '--manifest',
        manifestPath,
        '--candidates',
        resolve(REPO_ROOT, DEFAULT_CANDIDATES_PATH),
      ],
      { databaseUrl: url! }
    );

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Target scope mismatch');
    expect(await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshotBefore);
  });

  it('supports dry-run, applies 11 null->ru with groupKey matching and unpaired preservation, and is idempotent on repeat --apply', async () => {
    await seedSyntheticLibrary();
    const initialRows = await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } });
    const totalBefore = initialRows.length;
    expect(totalBefore).toBe(18);

    // 1. Dry-run by default: writes nothing
    const dryRun = runCli([], { databaseUrl: url! });
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain('[DRY-RUN] Legacy batch pictures selected: 11');
    expect(dryRun.stdout).toContain('Nothing was written.');

    const afterDryRun = await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } });
    expect(afterDryRun).toEqual(initialRows);

    // 2. First --apply: 11 null->ru, paired groupKeys shared, unpaired rows only update locale
    const firstApply = runCli(['--apply'], { databaseUrl: url! });
    expect(firstApply.status, firstApply.stderr).toBe(0);
    expect(firstApply.stdout).toContain('[APPLY] Legacy batch pictures selected: 11');
    expect(firstApply.stdout).toContain(`Library row count after: ${totalBefore}`);

    const afterApply = await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } });
    expect(afterApply).toHaveLength(totalBefore);

    const byId = new Map(afterApply.map((row) => [row.id, row]));
    for (let i = 0; i < targets.length; i++) {
      expect(byId.get(`ru-${i}`)?.locale).toBe('ru');
    }
    // Paired with custom English groupKey
    expect(byId.get('ru-0')?.groupKey).toBe('custom-almond-group');
    expect(byId.get('en-0')?.groupKey).toBe('custom-almond-group');
    // Paired with missing groupKey on both -> repository convention cell ref
    expect(byId.get('ru-1')?.groupKey).toBe(targets[1]!.ref);
    expect(byId.get('en-1')?.groupKey).toBe(targets[1]!.ref);
    // Paired via existing groupKey
    expect(byId.get('ru-2')?.groupKey).toBe('legacy-ryazhenka');
    expect(byId.get('en-2')?.groupKey).toBe('legacy-ryazhenka');
    // Unpaired with null groupKey -> stays null
    expect(byId.get('ru-3')?.groupKey).toBeNull();
    // Unpaired with ref groupKey -> stays ref
    for (let i = 4; i < targets.length; i++) {
      expect(byId.get(`ru-${i}`)?.groupKey).toBe(targets[i]!.ref);
    }
    // Unrelated rows untouched
    for (const id of ['other-universal', 'other-text-ru', 'other-text-en', 'other-upload']) {
      expect(byId.get(id)).toEqual(initialRows.find((r) => r.id === id));
    }

    // 3. Repeated --apply: zero changes, zero row writes, constant library count
    const secondApply = runCli(['--apply'], { databaseUrl: url! });
    expect(secondApply.status, secondApply.stderr).toBe(0);
    expect(secondApply.stdout).toContain(
      '[APPLY] Applied 0 row update(s) across 0 target(s); 11 unchanged.'
    );
    expect(secondApply.stdout).toContain(`Library row count after: ${totalBefore}`);

    const afterRepeat = await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } });
    expect(afterRepeat).toEqual(afterApply);
  });

  it('guards missing rows and groupKey collisions without partial writes', async () => {
    await seedSyntheticLibrary();
    // Delete one of the 11 required target rows -> must fail closed and leave all remaining rows unchanged
    await db.emojiLibraryItem.delete({ where: { id: 'ru-10' } });
    const snapshotMissing = await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } });

    const missingRes = runCli(['--apply'], { databaseUrl: url! });
    expect(missingRes.status).toBe(1);
    expect(missingRes.stderr).toContain(
      `Missing library item(s) for sourceRef: ${targets[10]!.ref}`
    );
    expect(await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshotMissing);

    // Restore ru-10 and introduce a groupKey collision on targets[1].ref (where ru-1 and en-1 have null groupKey)
    await db.emojiLibraryItem.create({
      data: {
        id: 'ru-10',
        name: targets[10]!.name,
        nameEn: targets[10]!.nameEn,
        tags: [targets[10]!.category.toLowerCase()],
        imageUrl: `https://example.invalid/emoji/${targets[10]!.batch}-${targets[10]!.cell}.webp`,
        source: 'batch',
        sourceRef: targets[10]!.ref,
        locale: null,
        groupKey: targets[10]!.ref,
      },
    });
    await db.emojiLibraryItem.update({
      where: { id: 'other-upload' },
      data: { groupKey: targets[1]!.ref },
    });
    const snapshotCollision = await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } });

    const collisionRes = runCli(['--apply'], { databaseUrl: url! });
    expect(collisionRes.status).toBe(1);
    expect(collisionRes.stderr).toContain('already used by another library item');
    expect(await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } })).toEqual(
      snapshotCollision
    );
  });

  it('rolls back partial writes atomically when PostgreSQL rejects a mid-apply update', async () => {
    await seedSyntheticLibrary();
    const snapshotBefore = await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } });

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_second_locale_update() RETURNS trigger AS $$
      BEGIN
        IF NEW."sourceRef" = 'batch-005#3' AND NEW."locale" = 'ru' THEN
          RAISE EXCEPTION 'simulated mid-apply write failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER test_fail_second_locale_update
      BEFORE UPDATE ON emoji_library_items
      FOR EACH ROW EXECUTE FUNCTION fail_second_locale_update();
    `);

    try {
      const res = runCli(['--apply'], { databaseUrl: url! });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('simulated mid-apply write failure');
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_fail_second_locale_update ON emoji_library_items'
      );
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_second_locale_update()');
    }

    expect(await db.emojiLibraryItem.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshotBefore);
  });
});
