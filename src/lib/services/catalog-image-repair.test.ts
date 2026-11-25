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

const VALID_WEBP_BYTES = Buffer.from(
  'UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA',
  'base64'
);

function webpOkResponse(method?: string) {
  return new Response(method === 'HEAD' ? null : VALID_WEBP_BYTES, {
    status: 200,
    headers: { 'content-type': 'image/webp' },
  });
}

const SAMPLE_ENTRY: RepairPlanEntry = {
  target: 'product',
  category: 'Молочные продукты',
  name: 'Сметана',
  expectedImageUrl: 'https://utfs.io/f/old-sour-cream',
  expectedIsCustom: true,
  newImageUrl: 'https://utfs.io/f/new-sour-cream',
};

function makeSimpleDb(expectedImageUrl = SAMPLE_ENTRY.expectedImageUrl) {
  const findCategoriesSpy = vi.fn(async () => [
    { id: 'c1', name: 'Молочные продукты', imageUrl: null, isCustom: false },
  ]);
  const updateManySpy = vi.fn();
  const db = {
    category: { findMany: findCategoriesSpy },
    product: {
      findMany: async () => [
        {
          id: 'p1',
          name: 'Сметана',
          categoryId: 'c1',
          imageUrl: expectedImageUrl,
          isCustom: true,
        },
      ],
      updateMany: updateManySpy,
    },
    productVariant: { findMany: async () => [] },
  } as unknown as RepairDbClient;
  return { db, findCategoriesSpy, updateManySpy };
}

describe('catalog-image-repair', () => {
  it('validates repair plans strictly against schema and storefront CDN URL contract (B3)', () => {
    expect(parseRepairPlan({ repairs: [SAMPLE_ENTRY] })).toEqual([SAMPLE_ENTRY]);

    const ufsEntry: RepairPlanEntry = {
      ...SAMPLE_ENTRY,
      newImageUrl: 'https://3kv5vvupx6.ufs.sh/f/new-sour-cream.webp',
    };
    expect(parseRepairPlan({ repairs: [ufsEntry] })).toEqual([ufsEntry]);

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
        repairs: [{ ...SAMPLE_ENTRY, newImageUrl: 'http://utfs.io/f/insecure.webp' }],
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

    const credentialedNewUrl = new URL('https://utfs.io/f/a.webp');
    credentialedNewUrl.username = 'user';
    credentialedNewUrl.password = 'pass';

    const disallowedNewUrls = [
      'https://evil.example/f/a.webp',
      'https://utfs.io/x/a.webp',
      'https://utfs.io/f/a/b.webp',
      'https://utfs.io/f/',
      'https://utfs.io/f/a.webp?x=1',
      'https://utfs.io:8443/f/a.webp',
      'https://other.ufs.sh/f/a.webp',
      credentialedNewUrl.toString(),
    ];
    for (const badUrl of disallowedNewUrls) {
      expect(() =>
        parseRepairPlan({ repairs: [{ ...SAMPLE_ENTRY, newImageUrl: badUrl }] })
      ).toThrowError(SafeOperationalError);
    }
  });

  it('rejects disallowed replacement URLs before any HTTP or DB call in dry-run and apply (B3)', async () => {
    const badEntry: RepairPlanEntry = {
      ...SAMPLE_ENTRY,
      newImageUrl: 'https://utfs.io/x/not-allowed-route.webp',
    };
    const fetchSpy = vi.fn();
    const { db, findCategoriesSpy, updateManySpy } = makeSimpleDb();
    const transactionSpy = vi.fn();
    const prisma = { $transaction: transactionSpy } as unknown as Parameters<
      typeof applyCatalogImageRepairs
    >[0];

    const currency = await verifyRepairCurrency([badEntry], {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(currency[0]?.ok).toBe(false);
    expect(currency[0]?.newHttpStatus).toBe('INVALID_URL');
    expect(fetchSpy).not.toHaveBeenCalled();

    const dryRun = await dryRunCatalogImageRepairs(db, [badEntry], {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(dryRun.exitCode).toBe(1);
    expect(dryRun.updatedCount).toBe(0);
    expect(dryRun.decisions[0]?.status).toBe('INVALID_URL');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(findCategoriesSpy).not.toHaveBeenCalled();
    expect(updateManySpy).not.toHaveBeenCalled();

    const applyRun = await applyCatalogImageRepairs(prisma, [badEntry], {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(applyRun.exitCode).toBe(1);
    expect(applyRun.updatedCount).toBe(0);
    expect(applyRun.decisions[0]?.status).toBe('INVALID_URL');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('requires consistent 404/410 for old URL and rejects 429/503/ambiguous as UNKNOWN without touching DB (B1)', async () => {
    const gone410Fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-sour-cream')) return new Response(null, { status: 410 });
      return webpOkResponse(init?.method);
    }) as typeof fetch;

    expect(await verifyRepairCurrency([SAMPLE_ENTRY], { fetchImpl: gone410Fetch })).toEqual([
      {
        targetLabel: '[product] Молочные продукты / Сметана',
        ok: true,
        oldState: 'PROVEN_MISSING',
        oldHttpStatus: 410,
        newHttpStatus: 200,
      },
    ]);

    const head405Old404Fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-sour-cream')) {
        if (init?.method === 'HEAD') return new Response(null, { status: 405 });
        return new Response(null, { status: 404 });
      }
      return webpOkResponse(init?.method);
    }) as typeof fetch;
    const fallbackOld = await verifyRepairCurrency([SAMPLE_ENTRY], {
      fetchImpl: head405Old404Fetch,
    });
    expect(fallbackOld[0]?.ok).toBe(true);
    expect(fallbackOld[0]?.oldHttpStatus).toBe(404);

    for (const status of [429, 503, 500, 403]) {
      const transientFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('old-sour-cream')) return new Response(null, { status });
        return webpOkResponse(init?.method);
      }) as typeof fetch;

      const outcome = await verifyRepairCurrency([SAMPLE_ENTRY], { fetchImpl: transientFetch });
      expect(outcome[0]?.ok).toBe(false);
      expect(outcome[0]?.oldState).toBe('UNKNOWN');
      expect(outcome[0]?.oldHttpStatus).toBe('UNKNOWN');

      const { db, updateManySpy } = makeSimpleDb();
      const dryRun = await dryRunCatalogImageRepairs(db, [SAMPLE_ENTRY], {
        fetchImpl: transientFetch,
      });
      expect(dryRun.exitCode).toBe(1);
      expect(dryRun.updatedCount).toBe(0);
      expect(dryRun.decisions[0]?.status).toBe('UNKNOWN');
      expect(updateManySpy).not.toHaveBeenCalled();

      const transactionSpy = vi.fn();
      const applyRun = await applyCatalogImageRepairs(
        { $transaction: transactionSpy } as unknown as Parameters<
          typeof applyCatalogImageRepairs
        >[0],
        [SAMPLE_ENTRY],
        { fetchImpl: transientFetch }
      );
      expect(applyRun.exitCode).toBe(1);
      expect(applyRun.updatedCount).toBe(0);
      expect(applyRun.decisions[0]?.status).toBe('UNKNOWN');
      expect(transactionSpy).not.toHaveBeenCalled();
    }

    // Mismatched HEAD/GET on old URL must also be treated as UNKNOWN.
    const oldMismatchFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-sour-cream')) {
        if (init?.method === 'HEAD') return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
      }
      return webpOkResponse(init?.method);
    }) as typeof fetch;
    const mismatchOutcome = await verifyRepairCurrency([SAMPLE_ENTRY], {
      fetchImpl: oldMismatchFetch,
    });
    expect(mismatchOutcome[0]?.ok).toBe(false);
    expect(mismatchOutcome[0]?.oldState).toBe('UNKNOWN');
  });

  it('requires real GET image payload for replacement URL and blocks HEAD/GET mismatch, HTML 200, and protocol downgrade redirects (B2)', async () => {
    const okFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-sour-cream')) return new Response(null, { status: 404 });
      return webpOkResponse(init?.method);
    }) as typeof fetch;

    expect(await verifyRepairCurrency([SAMPLE_ENTRY], { fetchImpl: okFetch })).toEqual([
      {
        targetLabel: '[product] Молочные продукты / Сметана',
        ok: true,
        oldState: 'PROVEN_MISSING',
        oldHttpStatus: 404,
        newHttpStatus: 200,
      },
    ]);

    const truncatedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-sour-cream')) return new Response(null, { status: 404 });
      return new Response(init?.method === 'HEAD' ? null : VALID_WEBP_BYTES.subarray(0, 12), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }) as typeof fetch;
    const truncatedTransaction = vi.fn();
    const truncated = await applyCatalogImageRepairs(
      { $transaction: truncatedTransaction } as unknown as Parameters<
        typeof applyCatalogImageRepairs
      >[0],
      [SAMPLE_ENTRY],
      { fetchImpl: truncatedFetch }
    );
    expect(truncated.exitCode).toBe(1);
    expect(truncated.updatedCount).toBe(0);
    expect(truncatedTransaction).not.toHaveBeenCalled();

    const head200Get404Fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-sour-cream')) return new Response(null, { status: 404 });
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const mismatchRes = await verifyRepairCurrency([SAMPLE_ENTRY], {
      fetchImpl: head200Get404Fetch,
    });
    expect(mismatchRes[0]?.ok).toBe(false);

    const transactionSpy = vi.fn();
    const applyMismatch = await applyCatalogImageRepairs(
      { $transaction: transactionSpy } as unknown as Parameters<typeof applyCatalogImageRepairs>[0],
      [SAMPLE_ENTRY],
      { fetchImpl: head200Get404Fetch }
    );
    expect(applyMismatch.exitCode).toBe(1);
    expect(applyMismatch.updatedCount).toBe(0);
    expect(transactionSpy).not.toHaveBeenCalled();

    const oldStill200Fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      webpOkResponse(init?.method)
    ) as typeof fetch;
    const still200 = await verifyRepairCurrency([SAMPLE_ENTRY], { fetchImpl: oldStill200Fetch });
    expect(still200[0]?.ok).toBe(false);
    expect(still200[0]?.oldState).toBe('STILL_PRESENT');

    const oldTimeoutFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('old-sour-cream')) {
        const e = new Error('timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      return webpOkResponse();
    }) as typeof fetch;
    const timeoutResult = await verifyRepairCurrency([SAMPLE_ENTRY], {
      fetchImpl: oldTimeoutFetch,
    });
    expect(timeoutResult[0]?.ok).toBe(false);
    expect(timeoutResult[0]?.oldState).toBe('UNKNOWN');

    const nonImageNewFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-sour-cream')) return new Response(null, { status: 404 });
      return new Response(init?.method === 'HEAD' ? null : '<html>not image</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;
    const nonImageResult = await verifyRepairCurrency([SAMPLE_ENTRY], {
      fetchImpl: nonImageNewFetch,
    });
    expect(nonImageResult[0]?.ok).toBe(false);

    // Redirect downgrade from https to http must be rejected.
    const downgradeFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('old-sour-cream')) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 302,
        headers: { location: 'http://utfs.io/f/downgraded.webp' },
      });
    }) as typeof fetch;
    const downgradeRes = await verifyRepairCurrency([SAMPLE_ENTRY], { fetchImpl: downgradeFetch });
    expect(downgradeRes[0]?.ok).toBe(false);

    // Redirect over HTTPS to valid image succeeds.
    const safeRedirectFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('old-sour-cream')) return new Response(null, { status: 404 });
      if (url.includes('new-sour-cream')) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://3kv5vvupx6.ufs.sh/f/target.webp' },
        });
      }
      return webpOkResponse(init?.method);
    }) as typeof fetch;
    const safeRedirectRes = await verifyRepairCurrency([SAMPLE_ENTRY], {
      fetchImpl: safeRedirectFetch,
    });
    expect(safeRedirectRes[0]?.ok).toBe(true);
  });

  it('performs dry-run without writes and reports conflicts cleanly', async () => {
    const { db, updateManySpy } = makeSimpleDb();

    const okFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-sour-cream') || String(input).includes('stale-url')) {
        return new Response(null, { status: 404 });
      }
      return webpOkResponse(init?.method);
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

    const { db: alreadyAppliedDb } = makeSimpleDb(SAMPLE_ENTRY.newImageUrl);

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

    const okFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('old-')) return new Response(null, { status: 404 });
      return webpOkResponse(init?.method);
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
