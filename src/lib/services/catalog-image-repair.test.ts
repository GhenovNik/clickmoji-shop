import { describe, expect, it, vi } from 'vitest';
import {
  applyCatalogImageRepairs,
  dryRunCatalogImageRepairs,
  parseRepairCliArgs,
  parseRepairPlan,
  verifyRepairCurrency,
  type RepairDbClient,
  type RepairPlanEntry,
} from './catalog-image-repair';
import { SafeOperationalError } from './catalog-image-http';

const SAMPLE_ENTRY: RepairPlanEntry = {
  target: 'product',
  category: 'Молочные продукты',
  name: 'Сметана',
  expectedImageUrl: 'https://utfs.io/f/old-sour-cream',
  expectedIsCustom: true,
  newImageUrl: 'https://utfs.io/f/new-sour-cream',
};

describe('catalog-image-repair', () => {
  it('validates repair plans strictly and rejects duplicates, missing fields, and non-https URLs', () => {
    const parsed = parseRepairPlan({ repairs: [SAMPLE_ENTRY] });
    expect(parsed).toEqual([SAMPLE_ENTRY]);

    expect(() => parseRepairPlan([])).toThrowError(SafeOperationalError);
    expect(() => parseRepairPlan({ repairs: [] })).toThrowError(SafeOperationalError);
    expect(() => parseRepairPlan({ repairs: [SAMPLE_ENTRY], extra: 1 })).toThrowError(
      SafeOperationalError
    );
    expect(() =>
      parseRepairPlan({
        repairs: [{ ...SAMPLE_ENTRY, newImageUrl: SAMPLE_ENTRY.expectedImageUrl }],
      })
    ).toThrowError(SafeOperationalError);
    expect(() =>
      parseRepairPlan({
        repairs: [{ ...SAMPLE_ENTRY, newImageUrl: 'http://insecure.example/x.webp' }],
      })
    ).toThrowError(SafeOperationalError);
    expect(() =>
      parseRepairPlan({
        repairs: [
          SAMPLE_ENTRY,
          { ...SAMPLE_ENTRY, name: 'сметана', category: 'молочные продукты' },
        ],
      })
    ).toThrowError(SafeOperationalError);
    expect(() =>
      parseRepairPlan({
        repairs: [
          {
            target: 'variant',
            category: 'Хлеб',
            parent: 'Хлеб',
            name: 'Багет',
            expectedImageUrl: 'https://utfs.io/f/old-v',
            expectedIsCustom: true,
            newImageUrl: 'https://utfs.io/f/new-v',
          },
        ],
      })
    ).toThrowError(SafeOperationalError);
  });

  it('verifies HTTP currency: requires broken old URL and HTTP 200 image/* new URL', async () => {
    const okFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('old-sour-cream')) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
    }) as typeof fetch;

    expect(await verifyRepairCurrency([SAMPLE_ENTRY], { fetchImpl: okFetch })).toEqual([
      {
        targetLabel: '[product] Молочные продукты / Сметана',
        ok: true,
        oldHttpStatus: 404,
        newHttpStatus: 200,
      },
    ]);

    const oldStill200Fetch = vi.fn(
      async () => new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } })
    ) as typeof fetch;
    const still200 = await verifyRepairCurrency([SAMPLE_ENTRY], { fetchImpl: oldStill200Fetch });
    expect(still200[0]?.ok).toBe(false);

    const oldTimeoutFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('old-sour-cream')) {
        const e = new Error('timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
    }) as typeof fetch;
    const timeoutResult = await verifyRepairCurrency([SAMPLE_ENTRY], {
      fetchImpl: oldTimeoutFetch,
    });
    expect(timeoutResult[0]?.ok).toBe(false);

    const nonImageNewFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('old-sour-cream')) return new Response(null, { status: 404 });
      return new Response('<html>not image</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;
    const nonImageResult = await verifyRepairCurrency([SAMPLE_ENTRY], {
      fetchImpl: nonImageNewFetch,
    });
    expect(nonImageResult[0]?.ok).toBe(false);
  });

  it('performs dry-run without writes and reports conflicts cleanly', async () => {
    const updateManySpy = vi.fn();
    const db = {
      category: {
        findMany: async () => [
          { id: 'c1', name: 'Молочные продукты', imageUrl: null, isCustom: false },
        ],
      },
      product: {
        findMany: async () => [
          {
            id: 'p1',
            name: 'Сметана',
            categoryId: 'c1',
            imageUrl: SAMPLE_ENTRY.expectedImageUrl,
            isCustom: true,
          },
        ],
        updateMany: updateManySpy,
      },
      productVariant: { findMany: async () => [] },
    } as unknown as RepairDbClient;

    const okFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('old-sour-cream') || String(input).includes('stale-url')) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
    }) as typeof fetch;

    const readyRun = await dryRunCatalogImageRepairs(db, [SAMPLE_ENTRY], { fetchImpl: okFetch });
    expect(readyRun.exitCode).toBe(0);
    expect(readyRun.updatedCount).toBe(0);
    expect(readyRun.decisions[0]?.status).toBe('READY');
    expect(updateManySpy).not.toHaveBeenCalled();

    const conflictRun = await dryRunCatalogImageRepairs(
      db,
      [{ ...SAMPLE_ENTRY, expectedImageUrl: 'https://utfs.io/f/stale-url' }],
      { fetchImpl: okFetch }
    );
    expect(conflictRun.exitCode).toBe(1);
    expect(conflictRun.decisions[0]?.status).toBe('CONFLICT');

    const alreadyAppliedDb = {
      category: {
        findMany: async () => [
          { id: 'c1', name: 'Молочные продукты', imageUrl: null, isCustom: false },
        ],
      },
      product: {
        findMany: async () => [
          {
            id: 'p1',
            name: 'Сметана',
            categoryId: 'c1',
            imageUrl: SAMPLE_ENTRY.newImageUrl,
            isCustom: true,
          },
        ],
      },
      productVariant: { findMany: async () => [] },
    } as unknown as RepairDbClient;

    const alreadyAppliedRun = await dryRunCatalogImageRepairs(alreadyAppliedDb, [SAMPLE_ENTRY], {
      fetchImpl: okFetch,
    });
    expect(alreadyAppliedRun.exitCode).toBe(1);
    expect(alreadyAppliedRun.decisions[0]?.status).toBe('ALREADY_APPLIED');

    const missingRun = await dryRunCatalogImageRepairs(
      db,
      [{ ...SAMPLE_ENTRY, name: 'Несуществующий' }],
      { fetchImpl: okFetch }
    );
    expect(missingRun.exitCode).toBe(1);
    expect(missingRun.decisions[0]?.status).toBe('NOT_FOUND');
  });

  it('applies atomically and aborts transaction when any update matches 0 rows (concurrent edit)', async () => {
    const secondEntry: RepairPlanEntry = {
      target: 'product',
      category: 'Молочные продукты',
      name: 'Творог',
      expectedImageUrl: 'https://utfs.io/f/old-curd',
      expectedIsCustom: true,
      newImageUrl: 'https://utfs.io/f/new-curd',
    };

    const okFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('old-')) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
    }) as typeof fetch;

    let committedState = new Map<string, string>([
      ['p1', SAMPLE_ENTRY.expectedImageUrl],
      ['p2', secondEntry.expectedImageUrl],
    ]);

    const makePrisma = (failSecondUpdate: boolean) => ({
      $transaction: async <T>(work: (tx: unknown) => Promise<T>) => {
        const draft = new Map(committedState);
        const tx = {
          $executeRawUnsafe: async () => undefined,
          category: {
            findMany: async () => [
              { id: 'c1', name: 'Молочные продукты', imageUrl: null, isCustom: false },
            ],
          },
          product: {
            findMany: async () => [
              {
                id: 'p1',
                name: 'Сметана',
                categoryId: 'c1',
                imageUrl: draft.get('p1') ?? null,
                isCustom: true,
              },
              {
                id: 'p2',
                name: 'Творог',
                categoryId: 'c1',
                imageUrl: draft.get('p2') ?? null,
                isCustom: true,
              },
            ],
            updateMany: async ({
              where,
              data,
            }: {
              where: { id: string; imageUrl: string };
              data: { imageUrl: string };
            }) => {
              if (failSecondUpdate && where.id === 'p2') {
                return { count: 0 };
              }
              if (draft.get(where.id) === where.imageUrl) {
                draft.set(where.id, data.imageUrl);
                return { count: 1 };
              }
              return { count: 0 };
            },
          },
          productVariant: { findMany: async () => [] },
        };
        const result = await work(tx);
        committedState = draft;
        return result;
      },
    });

    const rollbackResult = await applyCatalogImageRepairs(
      makePrisma(true) as unknown as Parameters<typeof applyCatalogImageRepairs>[0],
      [SAMPLE_ENTRY, secondEntry],
      { fetchImpl: okFetch }
    );
    expect(rollbackResult.exitCode).toBe(1);
    expect(rollbackResult.updatedCount).toBe(0);
    // Neither row changed in committedState because the transaction threw before committing.
    expect(committedState.get('p1')).toBe(SAMPLE_ENTRY.expectedImageUrl);
    expect(committedState.get('p2')).toBe(secondEntry.expectedImageUrl);

    const successResult = await applyCatalogImageRepairs(
      makePrisma(false) as unknown as Parameters<typeof applyCatalogImageRepairs>[0],
      [SAMPLE_ENTRY, secondEntry],
      { fetchImpl: okFetch }
    );
    expect(successResult.exitCode).toBe(0);
    expect(successResult.updatedCount).toBe(2);
    expect(committedState.get('p1')).toBe(SAMPLE_ENTRY.newImageUrl);
    expect(committedState.get('p2')).toBe(secondEntry.newImageUrl);
  });

  it('parses repair CLI arguments safely', () => {
    expect(parseRepairCliArgs(['--plan', 'plan.json'])).toEqual({
      help: false,
      apply: false,
      planPath: 'plan.json',
    });
    expect(parseRepairCliArgs(['--plan', 'plan.json', '--apply'])).toEqual({
      help: false,
      apply: true,
      planPath: 'plan.json',
    });
    expect(() => parseRepairCliArgs(['--plan'])).toThrowError(SafeOperationalError);
    expect(() => parseRepairCliArgs(['--bogus'])).toThrowError(SafeOperationalError);
  });
});
