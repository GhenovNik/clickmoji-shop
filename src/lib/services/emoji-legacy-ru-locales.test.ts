// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyLegacyRussianLocales,
  applyLegacyRussianLocalesInTx,
  loadLegacyRussianTargets,
  parseCliArgs,
  planLegacyRussianLocales,
  sanitizeDatabaseErrorMessage,
  type LegacyRussianTarget,
  type LibraryDbReader,
  type LibraryRow,
  type LibraryTxClient,
} from './emoji-legacy-ru-locales';

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

const TARGET_A: LegacyRussianTarget = {
  ref: 'batch-001#3',
  batch: 'batch-001',
  cell: 3,
  name: 'Миндальное масло',
  nameEn: 'Almond butter',
  category: 'Орехи и Сухофрукты',
  supersededBy: 'text-001#1',
};

const TARGET_B: LegacyRussianTarget = {
  ref: 'batch-005#3',
  batch: 'batch-005',
  cell: 3,
  name: 'Кефир',
  nameEn: 'Kefir',
  category: 'Молочные продукты',
  supersededBy: 'text-001#2',
};

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
});

describe('planLegacyRussianLocales & applyLegacyRussianLocales', () => {
  it('updates only locale on unpaired rows (preserving existing or null groupKey)', async () => {
    const { db, prisma, rows, updateMock } = makeFakeDb([
      {
        id: 'ru-1',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3',
        locale: null,
        groupKey: 'batch-001#3',
      },
      {
        id: 'ru-2',
        name: 'Кефир',
        nameEn: 'Kefir',
        source: 'batch',
        sourceRef: 'batch-005#3',
        locale: null,
        groupKey: null,
      },
    ]);

    const dryPlan = await planLegacyRussianLocales(db, [TARGET_A, TARGET_B]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(dryPlan.operations).toEqual([
      { id: 'ru-1', sourceRef: 'batch-001#3', data: { locale: 'ru' } },
      { id: 'ru-2', sourceRef: 'batch-005#3', data: { locale: 'ru' } },
    ]);

    const applied = await applyLegacyRussianLocales(prisma, [TARGET_A, TARGET_B]);
    expect(applied.appliedUpdates).toBe(2);
    expect(applied.totalLibraryCountAfter).toBe(2);
    expect(rows).toEqual([
      expect.objectContaining({ id: 'ru-1', locale: 'ru', groupKey: 'batch-001#3' }),
      expect.objectContaining({ id: 'ru-2', locale: 'ru', groupKey: null }),
    ]);

    const repeat = await applyLegacyRussianLocales(prisma, [TARGET_A, TARGET_B]);
    expect(repeat.appliedUpdates).toBe(0);
    expect(repeat.plan.operations).toEqual([]);
  });

  it('shares the English twin groupKey when present and falls back to cell ref when missing', async () => {
    const { prisma, rows } = makeFakeDb([
      {
        id: 'ru-a',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3',
        locale: null,
        groupKey: null,
      },
      {
        id: 'en-a',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3:en',
        locale: 'en',
        groupKey: 'custom-en-group',
      },
      {
        id: 'ru-b',
        name: 'Кефир',
        nameEn: 'Kefir',
        source: 'batch',
        sourceRef: 'batch-005#3',
        locale: null,
        groupKey: null,
      },
      {
        id: 'en-b',
        name: 'Кефир',
        nameEn: 'Kefir',
        source: 'batch',
        sourceRef: 'batch-005#3:en',
        locale: 'en',
        groupKey: null,
      },
    ]);

    const first = await applyLegacyRussianLocales(prisma, [TARGET_A, TARGET_B]);
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
      groupKey: 'batch-005#3',
    });
    expect(rows.find((r) => r.id === 'en-b')).toMatchObject({
      locale: 'en',
      groupKey: 'batch-005#3',
    });

    const second = await applyLegacyRussianLocales(prisma, [TARGET_A, TARGET_B]);
    expect(second.appliedUpdates).toBe(0);
  });

  it('locates an English twin sharing groupKey even when its sourceRef is null', async () => {
    const { prisma, rows } = makeFakeDb([
      {
        id: 'ru-b',
        name: 'Кефир',
        nameEn: 'Kefir',
        source: 'batch',
        sourceRef: 'batch-005#3',
        locale: null,
        groupKey: 'legacy-group-b',
      },
      {
        id: 'en-b',
        name: 'Кефир',
        nameEn: 'Kefir',
        source: 'upload',
        sourceRef: null,
        locale: 'en',
        groupKey: 'legacy-group-b',
      },
    ]);

    const res = await applyLegacyRussianLocales(prisma, [TARGET_B]);
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

  it('fails closed on missing target rows, unexpected locales, ambiguous twins, and groupKey collisions', async () => {
    const missing = makeFakeDb([]);
    await expect(planLegacyRussianLocales(missing.db, [TARGET_A])).rejects.toThrow(
      'Missing library item(s) for sourceRef: batch-001#3'
    );

    const wrongRuLocale = makeFakeDb([
      {
        id: 'ru-1',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3',
        locale: 'en',
        groupKey: 'batch-001#3',
      },
    ]);
    await expect(planLegacyRussianLocales(wrongRuLocale.db, [TARGET_A])).rejects.toThrow(
      'Unexpected locale "en" for batch-001#3'
    );

    const ambiguousTwins = makeFakeDb([
      {
        id: 'ru-1',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3',
        locale: null,
        groupKey: 'g-1',
      },
      {
        id: 'en-ref',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3:en',
        locale: 'en',
        groupKey: 'batch-001#3',
      },
      {
        id: 'en-group',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'upload',
        sourceRef: null,
        locale: 'en',
        groupKey: 'g-1',
      },
    ]);
    await expect(planLegacyRussianLocales(ambiguousTwins.db, [TARGET_A])).rejects.toThrow(
      'Ambiguous English versions for batch-001#3'
    );

    const groupCollision = makeFakeDb([
      {
        id: 'ru-1',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3',
        locale: null,
        groupKey: null,
      },
      {
        id: 'en-1',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3:en',
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
        groupKey: 'batch-001#3',
      },
    ]);
    await expect(planLegacyRussianLocales(groupCollision.db, [TARGET_A])).rejects.toThrow(
      'already used by another library item'
    );
  });

  it('propagates mid-transaction write failures cleanly inside applyLegacyRussianLocalesInTx', async () => {
    const { tx, updateMock } = makeFakeDb([
      {
        id: 'ru-1',
        name: 'Миндальное масло',
        nameEn: 'Almond butter',
        source: 'batch',
        sourceRef: 'batch-001#3',
        locale: null,
        groupKey: 'batch-001#3',
      },
      {
        id: 'ru-2',
        name: 'Кефир',
        nameEn: 'Kefir',
        source: 'batch',
        sourceRef: 'batch-005#3',
        locale: null,
        groupKey: 'batch-005#3',
      },
    ]);
    updateMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('write conflict'));

    await expect(applyLegacyRussianLocalesInTx(tx, [TARGET_A, TARGET_B])).rejects.toThrow(
      'write conflict'
    );
  });
});

describe('CLI entrypoint safety', () => {
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
});
