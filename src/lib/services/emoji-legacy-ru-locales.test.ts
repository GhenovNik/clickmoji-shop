// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyLegacyRussianLocales,
  applyLegacyRussianLocalesInTx,
  assertApprovedLegacyRussianTargets,
  DEFAULT_CANDIDATES_PATH,
  DEFAULT_MANIFEST_PATH,
  EXPECTED_LEGACY_TARGET_COUNT,
  loadCanonicalLegacyRussianTargets,
  loadLegacyRussianTargets,
  parseCliArgs,
  planLegacyRussianLocales,
  sanitizeDatabaseErrorMessage,
  type LibraryDbReader,
  type LibraryRow,
  type LibraryTxClient,
} from './emoji-legacy-ru-locales';

const REPO_ROOT = process.cwd();
const TSX_CLI = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const CLI_PATH = resolve(REPO_ROOT, 'scripts/emoji-legacy-ru-locales.ts');
const POSTGRES_RUNNER_PATH = resolve(REPO_ROOT, 'scripts/test-emoji-legacy-ru-locales-postgres.ts');
const PINNED_POSTGRES_IMAGE =
  'postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-ru-locales-'));
  tempDirs.push(dir);
  return dir;
}

function makeFakeDb(initialRows: LibraryRow[]): {
  db: LibraryDbReader;
  tx: LibraryTxClient;
  prisma: Pick<PrismaClient, '$transaction'>;
  rows: LibraryRow[];
  updateMock: ReturnType<typeof vi.fn>;
} {
  const rows = initialRows.map((row) => ({ ...row }));
  const matchesWhere = (
    row: LibraryRow,
    where?: { sourceRef?: { in: string[] }; groupKey?: { in: string[] } }
  ) => {
    if (!where) return true;
    if (where.sourceRef?.in) {
      return row.sourceRef !== null && where.sourceRef.in.includes(row.sourceRef);
    }
    if (where.groupKey?.in) {
      return row.groupKey !== null && where.groupKey.in.includes(row.groupKey);
    }
    return true;
  };

  const findMany = vi.fn(
    async (args?: { where?: { sourceRef?: { in: string[] }; groupKey?: { in: string[] } } }) =>
      rows.filter((row) => matchesWhere(row, args?.where)).map((row) => ({ ...row }))
  );
  const count = vi.fn(async () => rows.length);
  const updateMock = vi.fn(
    async (args: {
      where: { id: string };
      data: { locale?: string | null; groupKey?: string | null };
    }) => {
      const target = rows.find((row) => row.id === args.where.id);
      if (!target) throw new Error(`Row ${args.where.id} not found`);
      if (args.data.locale !== undefined) target.locale = args.data.locale;
      if (args.data.groupKey !== undefined) target.groupKey = args.data.groupKey;
      return { ...target };
    }
  );

  const db: LibraryDbReader = { emojiLibraryItem: { count, findMany } };
  const tx: LibraryTxClient = {
    emojiLibraryItem: {
      count,
      findMany,
      update: updateMock,
    },
  };
  const prisma: Pick<PrismaClient, '$transaction'> = {
    $transaction: vi.fn(async (callback: (client: LibraryTxClient) => Promise<unknown>) =>
      callback(tx)
    ) as unknown as PrismaClient['$transaction'],
  };

  return { db, tx, prisma, rows, updateMock };
}

const CANONICAL_TARGETS = loadCanonicalLegacyRussianTargets();
const TARGET_A = CANONICAL_TARGETS[0]!;
const TARGET_B = CANONICAL_TARGETS[1]!;

function makeCanonicalRows(
  overridesByRef: Record<string, Partial<LibraryRow> | null> = {},
  extraRows: LibraryRow[] = []
): LibraryRow[] {
  const rows: LibraryRow[] = [];
  for (let i = 0; i < CANONICAL_TARGETS.length; i++) {
    const target = CANONICAL_TARGETS[i]!;
    const override = overridesByRef[target.ref];
    if (override === null) continue;
    rows.push({
      id: `ru-${i}`,
      name: target.name,
      nameEn: target.nameEn,
      source: 'batch',
      sourceRef: target.ref,
      locale: 'ru',
      groupKey: target.ref,
      ...override,
    });
  }
  return [...rows, ...extraRows];
}

function createScopeVariantFiles(mode: 'incomplete' | 'expanded' | 'substituted') {
  const dir = createTempDir();
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, DEFAULT_MANIFEST_PATH), 'utf8')
  ) as Array<{
    batch: string;
    kind?: string;
    file?: string;
    cells: Array<{
      cell: number;
      category: string;
      name: string;
      nameEn: string;
      text?: boolean;
      action?: string;
      supersededBy?: string;
    }>;
  }>;
  const candidates = JSON.parse(
    readFileSync(resolve(REPO_ROOT, DEFAULT_CANDIDATES_PATH), 'utf8')
  ) as {
    redo: Array<Record<string, unknown>>;
    categories: Array<{ category: string; products: Array<Record<string, unknown>> }>;
  };

  let removedRef: string | null = null;
  let addedRef: string | null = null;

  if (mode === 'incomplete' || mode === 'substituted') {
    for (let b = manifest.length - 1; b >= 0 && !removedRef; b--) {
      const batch = manifest[b]!;
      if (batch.kind === 'text') continue;
      const idx = batch.cells.findIndex((cell) => Boolean(cell.supersededBy));
      if (idx !== -1) {
        const [removed] = batch.cells.splice(idx, 1);
        removedRef = `${batch.batch}#${removed!.cell}`;
      }
    }
  }

  if (mode === 'expanded' || mode === 'substituted') {
    const category = candidates.categories[0]!.category;
    const extraName = 'Тестовый продукт вне набора';
    const extraNameEn = 'Out of scope test product';
    addedRef = 'batch-999#1';
    manifest.push(
      {
        batch: 'batch-999',
        kind: 'universal',
        file: 'batch-999.png',
        cells: [
          {
            cell: 1,
            category,
            name: extraName,
            nameEn: extraNameEn,
            text: true,
            action: 'create',
            supersededBy: 'text-999#1',
          },
        ],
      },
      {
        batch: 'text-999',
        kind: 'text',
        file: 'text-999.png',
        cells: [
          {
            cell: 1,
            category,
            name: extraName,
            nameEn: extraNameEn,
            text: true,
            action: 'create',
          },
        ],
      }
    );
    candidates.categories[0]!.products.push({
      name: extraName,
      nameEn: extraNameEn,
      text: true,
    });
  }

  const manifestPath = join(dir, 'manifest.json');
  const candidatesPath = join(dir, 'candidates.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(candidatesPath, JSON.stringify(candidates));
  return { dir, manifestPath, candidatesPath, removedRef, addedRef };
}

function runShippedCli(args: string[], opts: { databaseUrl?: string; cwd?: string } = {}) {
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

describe('parseCliArgs', () => {
  it('defaults to dry-run and repository paths', () => {
    expect(parseCliArgs([])).toEqual({
      apply: false,
      help: false,
      manifestPath: 'docs/emoji-batches/manifest.json',
      candidatesPath: 'docs/emoji-batches/candidates.json',
    });
  });

  it('parses --apply and path overrides', () => {
    expect(
      parseCliArgs(['--apply', '--manifest', '/tmp/m.json', '--candidates', '/tmp/c.json'])
    ).toEqual({
      apply: true,
      help: false,
      manifestPath: '/tmp/m.json',
      candidatesPath: '/tmp/c.json',
    });
  });

  it('rejects unknown flags and missing option values', () => {
    expect(() => parseCliArgs(['--aply'])).toThrow('Unknown argument: --aply');
    expect(() => parseCliArgs(['--manifest'])).toThrow('Option --manifest requires a file path');
    expect(() => parseCliArgs(['--candidates', '--apply'])).toThrow(
      'Option --candidates requires a file path'
    );
  });
});

describe('loadLegacyRussianTargets', () => {
  it('selects the 11 superseded batch-NNN cells from repository manifest and candidates', () => {
    const targets = loadLegacyRussianTargets();
    expect(targets).toHaveLength(11);
    for (const target of targets) {
      expect(target.ref).toMatch(/^batch-\d+#\d+$/);
      expect(target.supersededBy).toMatch(/^text-\d+#\d+$/);
    }
    expect(new Set(targets.map((t) => t.ref)).size).toBe(11);
  });

  it('guards missing or invalid manifest and candidates inputs', () => {
    const dir = createTempDir();
    const validCandidates = join(dir, 'candidates.json');
    const validManifest = join(dir, 'manifest.json');
    writeFileSync(
      validCandidates,
      JSON.stringify({
        redo: [],
        categories: [
          { category: 'Dairy', products: [{ name: 'Кефир', nameEn: 'Kefir', text: true }] },
        ],
      })
    );
    writeFileSync(
      validManifest,
      JSON.stringify([
        {
          batch: 'batch-005',
          kind: 'universal',
          file: 'batch-005.png',
          cells: [
            {
              cell: 3,
              category: 'Dairy',
              name: 'Кефир',
              nameEn: 'Kefir',
              text: true,
              action: 'create',
              supersededBy: 'text-001#2',
            },
          ],
        },
        {
          batch: 'text-001',
          kind: 'text',
          file: 'text-001.png',
          cells: [
            {
              cell: 2,
              category: 'Dairy',
              name: 'Кефир',
              nameEn: 'Kefir',
              text: true,
              action: 'create',
            },
          ],
        },
      ])
    );

    expect(() =>
      loadLegacyRussianTargets({
        manifestPath: join(dir, 'missing.json'),
        candidatesPath: validCandidates,
      })
    ).toThrow('Failed to read manifest file');

    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{not-json');
    expect(() =>
      loadLegacyRussianTargets({ manifestPath: badJson, candidatesPath: validCandidates })
    ).toThrow('Invalid JSON in manifest file');

    const missingTargetManifest = join(dir, 'missing-target.json');
    writeFileSync(
      missingTargetManifest,
      JSON.stringify([
        {
          batch: 'batch-005',
          kind: 'universal',
          file: 'batch-005.png',
          cells: [
            {
              cell: 3,
              category: 'Dairy',
              name: 'Кефир',
              nameEn: 'Kefir',
              text: true,
              action: 'create',
              supersededBy: 'text-999#1',
            },
          ],
        },
      ])
    );
    expect(() =>
      loadLegacyRussianTargets({
        manifestPath: missingTargetManifest,
        candidatesPath: validCandidates,
      })
    ).toThrow('Missing supersededBy target "text-999#1"');

    const nonTextCandidate = join(dir, 'non-text-candidates.json');
    writeFileSync(
      nonTextCandidate,
      JSON.stringify({
        redo: [],
        categories: [{ category: 'Dairy', products: [{ name: 'Кефир', nameEn: 'Kefir' }] }],
      })
    );
    expect(() =>
      loadLegacyRussianTargets({ manifestPath: validManifest, candidatesPath: nonTextCandidate })
    ).toThrow('missing text=true candidate');

    const textWithoutSuperseded = join(dir, 'no-superseded.json');
    writeFileSync(
      textWithoutSuperseded,
      JSON.stringify([
        {
          batch: 'batch-005',
          kind: 'universal',
          file: 'batch-005.png',
          cells: [
            {
              cell: 3,
              category: 'Dairy',
              name: 'Кефир',
              nameEn: 'Kefir',
              text: true,
              action: 'create',
            },
          ],
        },
      ])
    );
    expect(() =>
      loadLegacyRussianTargets({
        manifestPath: textWithoutSuperseded,
        candidatesPath: validCandidates,
      })
    ).toThrow('marked as text without supersededBy');
  });

  it('enforces exact canonical count and rejects incomplete, expanded, and substituted sets', () => {
    expect(CANONICAL_TARGETS).toHaveLength(EXPECTED_LEGACY_TARGET_COUNT);

    const incomplete = createScopeVariantFiles('incomplete');
    expect(() =>
      loadCanonicalLegacyRussianTargets({
        manifestPath: incomplete.manifestPath,
        candidatesPath: incomplete.candidatesPath,
      })
    ).toThrow(`must define exactly ${EXPECTED_LEGACY_TARGET_COUNT}`);

    const incompleteTargets = loadLegacyRussianTargets({
      manifestPath: incomplete.manifestPath,
      candidatesPath: incomplete.candidatesPath,
    });
    expect(incompleteTargets).toHaveLength(EXPECTED_LEGACY_TARGET_COUNT - 1);
    expect(() => assertApprovedLegacyRussianTargets(incompleteTargets)).toThrow(
      `Target scope mismatch: expected the ${EXPECTED_LEGACY_TARGET_COUNT} canonical sourceRef(s), got ${EXPECTED_LEGACY_TARGET_COUNT - 1} (missing: ${incomplete.removedRef})`
    );

    const expanded = createScopeVariantFiles('expanded');
    const expandedTargets = loadLegacyRussianTargets({
      manifestPath: expanded.manifestPath,
      candidatesPath: expanded.candidatesPath,
    });
    expect(expandedTargets).toHaveLength(EXPECTED_LEGACY_TARGET_COUNT + 1);
    expect(() => assertApprovedLegacyRussianTargets(expandedTargets)).toThrow(
      `Target scope mismatch: expected the ${EXPECTED_LEGACY_TARGET_COUNT} canonical sourceRef(s), got ${EXPECTED_LEGACY_TARGET_COUNT + 1} (unexpected: ${expanded.addedRef})`
    );

    const substituted = createScopeVariantFiles('substituted');
    const substitutedTargets = loadLegacyRussianTargets({
      manifestPath: substituted.manifestPath,
      candidatesPath: substituted.candidatesPath,
    });
    expect(substitutedTargets).toHaveLength(EXPECTED_LEGACY_TARGET_COUNT);
    expect(() => assertApprovedLegacyRussianTargets(substitutedTargets)).toThrow(
      `Target scope mismatch: expected the ${EXPECTED_LEGACY_TARGET_COUNT} canonical sourceRef(s), got ${EXPECTED_LEGACY_TARGET_COUNT} (missing: ${substituted.removedRef}; unexpected: ${substituted.addedRef})`
    );

    const duplicated = [...CANONICAL_TARGETS.slice(0, EXPECTED_LEGACY_TARGET_COUNT - 1), TARGET_A];
    expect(() => assertApprovedLegacyRussianTargets(duplicated)).toThrow(
      'Duplicate target cell references'
    );
  });
});

describe('planLegacyRussianLocales & applyLegacyRussianLocales', () => {
  it('updates only locale on unpaired rows (preserving existing or null groupKey)', async () => {
    const { db, prisma, rows, updateMock } = makeFakeDb(
      makeCanonicalRows({
        [TARGET_A.ref]: { id: 'ru-1', locale: null, groupKey: TARGET_A.ref },
        [TARGET_B.ref]: { id: 'ru-2', locale: null, groupKey: null },
      })
    );

    const dryPlan = await planLegacyRussianLocales(db, CANONICAL_TARGETS);
    expect(updateMock).not.toHaveBeenCalled();
    expect(dryPlan.operations).toEqual([
      { id: 'ru-1', sourceRef: TARGET_A.ref, data: { locale: 'ru' } },
      { id: 'ru-2', sourceRef: TARGET_B.ref, data: { locale: 'ru' } },
    ]);

    const applied = await applyLegacyRussianLocales(prisma, CANONICAL_TARGETS);
    expect(applied.appliedUpdates).toBe(2);
    expect(applied.totalLibraryCountAfter).toBe(EXPECTED_LEGACY_TARGET_COUNT);
    expect(rows.slice(0, 2)).toEqual([
      expect.objectContaining({ id: 'ru-1', locale: 'ru', groupKey: TARGET_A.ref }),
      expect.objectContaining({ id: 'ru-2', locale: 'ru', groupKey: null }),
    ]);

    const repeat = await applyLegacyRussianLocales(prisma, CANONICAL_TARGETS);
    expect(repeat.appliedUpdates).toBe(0);
    expect(repeat.plan.operations).toEqual([]);
  });

  it('shares the English twin groupKey when present and falls back to cell ref when missing', async () => {
    const { prisma, rows } = makeFakeDb(
      makeCanonicalRows(
        {
          [TARGET_A.ref]: { id: 'ru-a', locale: null, groupKey: null },
          [TARGET_B.ref]: { id: 'ru-b', locale: null, groupKey: null },
        },
        [
          {
            id: 'en-a',
            name: TARGET_A.name,
            nameEn: TARGET_A.nameEn,
            source: 'batch',
            sourceRef: `${TARGET_A.ref}:en`,
            locale: 'en',
            groupKey: 'custom-en-group',
          },
          {
            id: 'en-b',
            name: TARGET_B.name,
            nameEn: TARGET_B.nameEn,
            source: 'batch',
            sourceRef: `${TARGET_B.ref}:en`,
            locale: 'en',
            groupKey: null,
          },
        ]
      )
    );

    const first = await applyLegacyRussianLocales(prisma, CANONICAL_TARGETS);
    expect(first.appliedUpdates).toBe(3);
    expect(rows.find((r) => r.id === 'ru-a')).toMatchObject({
      locale: 'ru',
      groupKey: 'custom-en-group',
    });
    expect(rows.find((r) => r.id === 'en-a')).toMatchObject({
      locale: 'en',
      groupKey: 'custom-en-group',
    });
    expect(rows.find((r) => r.id === 'ru-b')).toMatchObject({
      locale: 'ru',
      groupKey: TARGET_B.ref,
    });
    expect(rows.find((r) => r.id === 'en-b')).toMatchObject({
      locale: 'en',
      groupKey: TARGET_B.ref,
    });

    const second = await applyLegacyRussianLocales(prisma, CANONICAL_TARGETS);
    expect(second.appliedUpdates).toBe(0);
  });

  it('locates an English twin sharing groupKey even when its sourceRef is null', async () => {
    const { prisma, rows } = makeFakeDb(
      makeCanonicalRows(
        {
          [TARGET_B.ref]: { id: 'ru-b', locale: null, groupKey: 'legacy-group-b' },
        },
        [
          {
            id: 'en-b',
            name: TARGET_B.name,
            nameEn: TARGET_B.nameEn,
            source: 'upload',
            sourceRef: null,
            locale: 'en',
            groupKey: 'legacy-group-b',
          },
        ]
      )
    );

    const res = await applyLegacyRussianLocales(prisma, CANONICAL_TARGETS);
    expect(res.appliedUpdates).toBe(1);
    expect(rows.find((r) => r.id === 'ru-b')).toMatchObject({
      locale: 'ru',
      groupKey: 'legacy-group-b',
    });
    expect(rows.find((r) => r.id === 'en-b')).toMatchObject({
      locale: 'en',
      groupKey: 'legacy-group-b',
    });
  });

  it('guards plan and apply entrypoints against scope drift before touching the database', async () => {
    const fake = makeFakeDb(makeCanonicalRows());

    for (const mode of ['incomplete', 'expanded', 'substituted'] as const) {
      const variant = createScopeVariantFiles(mode);
      const drifted = loadLegacyRussianTargets({
        manifestPath: variant.manifestPath,
        candidatesPath: variant.candidatesPath,
      });

      await expect(planLegacyRussianLocales(fake.db, drifted)).rejects.toThrow(
        'Target scope mismatch'
      );
      await expect(applyLegacyRussianLocales(fake.prisma, drifted)).rejects.toThrow(
        'Target scope mismatch'
      );
      await expect(applyLegacyRussianLocalesInTx(fake.tx, drifted)).rejects.toThrow(
        'Target scope mismatch'
      );
    }

    expect(fake.updateMock).not.toHaveBeenCalled();
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed on missing target rows, unexpected locales, ambiguous twins, and groupKey collisions', async () => {
    const missing = makeFakeDb(makeCanonicalRows({ [TARGET_A.ref]: null }));
    await expect(planLegacyRussianLocales(missing.db, CANONICAL_TARGETS)).rejects.toThrow(
      `Missing library item(s) for sourceRef: ${TARGET_A.ref}`
    );

    const wrongRuLocale = makeFakeDb(
      makeCanonicalRows({
        [TARGET_A.ref]: { id: 'ru-1', locale: 'en', groupKey: TARGET_A.ref },
      })
    );
    await expect(planLegacyRussianLocales(wrongRuLocale.db, CANONICAL_TARGETS)).rejects.toThrow(
      `Unexpected locale "en" for ${TARGET_A.ref}`
    );

    const ambiguousTwins = makeFakeDb(
      makeCanonicalRows(
        {
          [TARGET_A.ref]: { id: 'ru-1', locale: null, groupKey: 'g-1' },
        },
        [
          {
            id: 'en-ref',
            name: TARGET_A.name,
            nameEn: TARGET_A.nameEn,
            source: 'batch',
            sourceRef: `${TARGET_A.ref}:en`,
            locale: 'en',
            groupKey: TARGET_A.ref,
          },
          {
            id: 'en-group',
            name: TARGET_A.name,
            nameEn: TARGET_A.nameEn,
            source: 'upload',
            sourceRef: null,
            locale: 'en',
            groupKey: 'g-1',
          },
        ]
      )
    );
    await expect(planLegacyRussianLocales(ambiguousTwins.db, CANONICAL_TARGETS)).rejects.toThrow(
      `Ambiguous English versions for ${TARGET_A.ref}`
    );

    const groupCollision = makeFakeDb(
      makeCanonicalRows(
        {
          [TARGET_A.ref]: { id: 'ru-1', locale: null, groupKey: null },
        },
        [
          {
            id: 'en-1',
            name: TARGET_A.name,
            nameEn: TARGET_A.nameEn,
            source: 'batch',
            sourceRef: `${TARGET_A.ref}:en`,
            locale: 'en',
            groupKey: null,
          },
          {
            id: 'stranger',
            name: 'Other',
            nameEn: 'Other',
            source: 'upload',
            sourceRef: null,
            locale: null,
            groupKey: TARGET_A.ref,
          },
        ]
      )
    );
    await expect(planLegacyRussianLocales(groupCollision.db, CANONICAL_TARGETS)).rejects.toThrow(
      'already used by another library item'
    );
  });

  it('propagates mid-transaction write failures cleanly inside applyLegacyRussianLocalesInTx', async () => {
    const { tx, updateMock } = makeFakeDb(
      makeCanonicalRows({
        [TARGET_A.ref]: { id: 'ru-1', locale: null, groupKey: TARGET_A.ref },
        [TARGET_B.ref]: { id: 'ru-2', locale: null, groupKey: TARGET_B.ref },
      })
    );
    updateMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('write conflict'));

    await expect(applyLegacyRussianLocalesInTx(tx, CANONICAL_TARGETS)).rejects.toThrow(
      'write conflict'
    );
  });
});

describe('CLI entrypoint safety & offline postgres runner', () => {
  it('never imports dotenv in the CLI script', () => {
    const source = readFileSync('scripts/emoji-legacy-ru-locales.ts', 'utf8');
    expect(source).not.toMatch(/dotenv/);
  });

  it('redacts connection strings in sanitized error messages', () => {
    expect(
      sanitizeDatabaseErrorMessage(
        'Failed connecting to postgresql://user:secret@127.0.0.1:5432/db'
      )
    ).toBe('Failed connecting to [redacted-database-url]');
  });

  it('documents the emoji-import operational prohibition in --help output without requiring DATABASE_URL', () => {
    const res = runShippedCli(['--help']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('Operational warning:');
    expect(res.stdout).toContain('do NOT reimport superseded legacy batches');
    expect(res.stdout).toContain('scripts/emoji-import.ts');
    expect(res.stdout).toContain('resets these tags');
  });

  it('rejects incomplete, expanded, and substituted override sets in the shipped CLI before checking DATABASE_URL', () => {
    for (const mode of ['incomplete', 'expanded', 'substituted'] as const) {
      const variant = createScopeVariantFiles(mode);
      const res = runShippedCli([
        '--apply',
        '--manifest',
        variant.manifestPath,
        '--candidates',
        variant.candidatesPath,
      ]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Target scope mismatch');
      expect(res.stderr).not.toContain('DATABASE_URL is not set');
    }
  });

  it('enforces pre-staged pinned image offline without pull and preserves primary diagnostics on cleanup failure', () => {
    const setupFakeDocker = (scriptBody: string) => {
      const dir = createTempDir();
      const binDir = join(dir, 'bin');
      const logFile = join(dir, 'docker.log');
      mkdirSync(binDir, { recursive: true });
      const fakeDocker = join(binDir, 'docker');
      writeFileSync(fakeDocker, scriptBody);
      chmodSync(fakeDocker, 0o755);
      return { binDir, logFile };
    };

    const runPostgresRunner = (binDir: string, logFile: string) =>
      spawnSync(process.execPath, [TSX_CLI, POSTGRES_RUNNER_PATH], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          DOCKER_LOG_FILE: logFile,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    // 1. Prerequisite image inspect fails -> exits without pull, run, or rm
    const missingImage = setupFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG_FILE"
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  echo "Error response from daemon: No such image: $5" >&2
  exit 1
fi
exit 0
`);
    const missingRes = runPostgresRunner(missingImage.binDir, missingImage.logFile);
    expect(missingRes.status).toBe(1);
    expect(missingRes.stderr).toContain('Offline PostgreSQL prerequisite failed');
    expect(missingRes.stderr).toContain('No such image');
    const missingCalls = readFileSync(missingImage.logFile, 'utf8').trim().split('\n');
    expect(missingCalls).toHaveLength(1);
    expect(missingCalls[0]).toContain(`image inspect --format {{.Id}} ${PINNED_POSTGRES_IMAGE}`);
    expect(missingCalls.join('\n')).not.toContain('pull');
    expect(missingCalls.join('\n')).not.toContain('run ');
    expect(missingCalls.join('\n')).not.toContain('rm ');

    // 2. docker run --pull=never fails even if inspect passed -> primary run error preserved
    const runFail = setupFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG_FILE"
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  echo "sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"
  exit 0
fi
if [ "$1" = "run" ]; then
  echo "pull access denied with --pull=never" >&2
  exit 125
fi
if [ "$1" = "rm" ]; then
  echo "cleanup should not mask run failure" >&2
  exit 1
fi
exit 0
`);
    const runFailRes = runPostgresRunner(runFail.binDir, runFail.logFile);
    expect(runFailRes.status).toBe(1);
    expect(runFailRes.stderr).toContain('pull access denied with --pull=never');
    expect(runFailRes.stderr).not.toContain('cleanup should not mask run failure');
    const runFailCalls = readFileSync(runFail.logFile, 'utf8').trim().split('\n');
    expect(runFailCalls[1]).toContain('--pull=never');
    expect(runFailCalls[1]).toContain(PINNED_POSTGRES_IMAGE);
    expect(runFailCalls[1]).not.toContain('postgres:17-alpine');

    // 3. Container starts, primary failure occurs at port check, and rm --force also fails ->
    // primary diagnostic is preserved and not masked by cleanup failure
    const cleanupFail = setupFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG_FILE"
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  echo "sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"
  exit 0
fi
if [ "$1" = "run" ] || [ "$1" = "exec" ]; then
  exit 0
fi
if [ "$1" = "port" ]; then
  echo "0.0.0.0:5432"
  exit 0
fi
if [ "$1" = "rm" ]; then
  echo "simulated cleanup failure" >&2
  exit 1
fi
exit 0
`);
    const cleanupFailRes = runPostgresRunner(cleanupFail.binDir, cleanupFail.logFile);
    expect(cleanupFailRes.status).toBe(1);
    expect(cleanupFailRes.stderr).toContain('Expected a loopback-only Docker port');
    expect(cleanupFailRes.stderr).toContain('simulated cleanup failure');
  });
});
