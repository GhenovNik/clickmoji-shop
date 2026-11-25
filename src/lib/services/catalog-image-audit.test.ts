import { describe, expect, it, vi } from 'vitest';
import {
  auditCatalogPrimaryImages,
  formatAuditReportLines,
  parseAuditCliArgs,
  type CatalogAuditDbReader,
} from './catalog-image-audit';
import { SafeOperationalError, safeErrorTag } from './catalog-image-http';

function makeDb(data: {
  categories?: Array<{ name: string; isCustom: boolean; imageUrl: string | null }>;
  products?: Array<{ name: string; isCustom: boolean; imageUrl: string | null }>;
  variants?: Array<{ name: string; imageUrl: string | null; product: { name: string } }>;
  sqlCalls?: string[];
}): CatalogAuditDbReader {
  const reader: CatalogAuditDbReader = {
    category: {
      findMany: async () => data.categories ?? [],
    },
    product: {
      findMany: async () => data.products ?? [],
    },
    productVariant: {
      findMany: async () => data.variants ?? [],
    },
  };
  reader.$transaction = (async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      ...reader,
      $executeRawUnsafe: async (sql: string) => {
        data.sqlCalls?.push(sql);
      },
    };
    return fn(tx);
  }) as CatalogAuditDbReader['$transaction'];
  return reader;
}

describe('catalog-image-audit', () => {
  it('passes with exitCode 0 when every primary image returns HTTP 200 and skips emoji-only items', async () => {
    const sqlCalls: string[] = [];
    const db = makeDb({
      sqlCalls,
      categories: [
        { name: 'Овощи', isCustom: false, imageUrl: null },
        { name: 'Напитки', isCustom: true, imageUrl: 'https://cdn.example/cat-drinks.webp' },
      ],
      products: [
        { name: 'Артишок', isCustom: true, imageUrl: 'https://cdn.example/artichoke.webp' },
        { name: 'Укроп без картинки', isCustom: false, imageUrl: null },
      ],
      variants: [
        {
          name: 'Яблоко Ханикрисп',
          imageUrl: 'https://cdn.example/honeycrisp.webp',
          product: { name: 'Яблоко' },
        },
        { name: 'Хлеб белый', imageUrl: null, product: { name: 'Хлеб' } },
      ],
    });

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;

    const report = await auditCatalogPrimaryImages(db, { fetchImpl });

    expect(sqlCalls).toEqual(['SET TRANSACTION READ ONLY']);
    expect(report.exitCode).toBe(0);
    expect(report.checkedCount).toBe(3);
    expect(report.okCount).toBe(3);
    expect(report.failedCount).toBe(0);
    expect(report.withoutUrlCount).toBe(3);

    const lines = formatAuditReportLines(report);
    expect(lines).toEqual([
      '[category] Напитки: HTTP 200',
      'Артишок: HTTP 200',
      '[variant] Яблоко / Яблоко Ханикрисп: HTTP 200',
      'Summary: checked=3, ok_200=3, failed=0, non_200=0, missing_url=0, invalid_url=0, network_errors=0, emoji_only=3',
    ]);
    expect(lines.join('\n')).not.toContain('https://');
  });

  it('falls back to GET when HEAD returns 405 or 501', async () => {
    const db = makeDb({
      products: [{ name: 'Брынза', isCustom: true, imageUrl: 'https://cdn.example/feta.webp' }],
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const report = await auditCatalogPrimaryImages(db, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(report.exitCode).toBe(0);
    expect(report.entries).toEqual([
      { kind: 'product', name: 'Брынза', status: 'HTTP 200', ok: true },
    ]);
  });

  it('flags non-200 HTTP, missing custom URLs, invalid URLs, timeouts, and network errors without leaking URLs or raw exceptions', async () => {
    const db = makeDb({
      products: [
        { name: 'Сметана', isCustom: true, imageUrl: 'https://utfs.io/f/secret-key-404' },
        { name: 'Крем для лица', isCustom: true, imageUrl: null },
        { name: 'Кетчуп', isCustom: true, imageUrl: 'not a valid url' },
        { name: 'Майонез', isCustom: true, imageUrl: 'https://utfs.io/f/secret-timeout' },
        { name: 'Сухарики', isCustom: true, imageUrl: 'https://utfs.io/f/secret-network-err' },
      ],
    });

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('secret-key-404')) return new Response(null, { status: 404 });
      if (url.includes('secret-timeout')) {
        const err = new Error('request timed out for https://utfs.io/f/secret-timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      throw new Error('ECONNREFUSED https://utfs.io/f/secret-network-err token=secret');
    }) as typeof fetch;

    const report = await auditCatalogPrimaryImages(db, { fetchImpl });

    expect(report.exitCode).toBe(1);
    expect(report.checkedCount).toBe(5);
    expect(report.failedCount).toBe(5);
    expect(report.non200HttpCount).toBe(1);
    expect(report.missingUrlCount).toBe(1);
    expect(report.invalidUrlCount).toBe(1);
    expect(report.networkErrorCount).toBe(2);

    const rendered = formatAuditReportLines(report).join('\n');
    expect(rendered).toContain('Сметана: HTTP 404');
    expect(rendered).toContain('Крем для лица: MISSING_URL');
    expect(rendered).toContain('Кетчуп: INVALID_URL');
    expect(rendered).toContain('Майонез: TIMEOUT');
    expect(rendered).toContain('Сухарики: NETWORK_ERROR');
    expect(rendered).not.toContain('utfs.io');
    expect(rendered).not.toContain('https://');
    expect(rendered).not.toContain('secret');
    expect(rendered).not.toContain('ECONNREFUSED');
  });

  it('fails closed on empty catalog or database read failure without exposing connection strings', async () => {
    const emptyDb = makeDb({});
    await expect(auditCatalogPrimaryImages(emptyDb)).rejects.toMatchObject({
      code: 'EMPTY_CATALOG',
    });

    const brokenDb: CatalogAuditDbReader = {
      category: {
        findMany: async () => {
          throw new Error('postgresql://user:secret@host/db failed');
        },
      },
      product: { findMany: async () => [] },
      productVariant: { findMany: async () => [] },
    };

    let caught: unknown;
    try {
      await auditCatalogPrimaryImages(brokenDb);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SafeOperationalError);
    expect(safeErrorTag(caught)).toBe('DATABASE_READ_FAILED');
    expect((caught as Error).message).not.toContain('postgresql://');
    expect((caught as Error).message).not.toContain('secret');
  });

  it('supports --failures-only formatting and CLI argument validation', async () => {
    const db = makeDb({
      products: [
        { name: 'Ок', isCustom: true, imageUrl: 'https://cdn.example/ok.webp' },
        { name: 'Сбой', isCustom: true, imageUrl: 'https://cdn.example/bad.webp' },
      ],
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('ok.webp')
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 500 })
    ) as typeof fetch;

    const report = await auditCatalogPrimaryImages(db, { fetchImpl });
    const failuresOnly = formatAuditReportLines(report, { failuresOnly: true });
    expect(failuresOnly).toEqual([
      'Сбой: HTTP 500',
      'Summary: checked=2, ok_200=1, failed=1, non_200=1, missing_url=0, invalid_url=0, network_errors=0, emoji_only=0',
    ]);

    expect(parseAuditCliArgs(['--help'])).toEqual({ help: true, failuresOnly: false });
    expect(parseAuditCliArgs(['--failures-only'])).toEqual({ help: false, failuresOnly: true });
    expect(() => parseAuditCliArgs(['--unknown'])).toThrowError(SafeOperationalError);
  });
});
