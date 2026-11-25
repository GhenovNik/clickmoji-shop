import { describe, expect, it, vi } from 'vitest';
import {
  auditCatalogPrimaryImages,
  formatAuditReportLines,
  parseAuditCliArgs,
  type CatalogAuditDbReader,
} from './catalog-image-audit';
import { SafeOperationalError, safeErrorTag } from './catalog-image-http';

const VALID_WEBP_BYTES = Buffer.from(
  'UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA',
  'base64'
);
const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const VALID_JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const VALID_GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00', 'ascii');
const VALID_AVIF_BYTES = Buffer.from('\x00\x00\x00\x18ftypavif\x00\x00\x00\x00avifmif1', 'latin1');

function webpOkResponse(init?: { method?: string; url?: string }) {
  const body = init?.method === 'HEAD' ? null : VALID_WEBP_BYTES;
  const res = new Response(body, { status: 200, headers: { 'content-type': 'image/webp' } });
  if (init?.url) {
    Object.defineProperty(res, 'url', { value: init.url });
  }
  return res;
}

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
  it('passes with exitCode 0 when every primary image returns valid GET image bytes and skips emoji-only items', async () => {
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

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      webpOkResponse({ method: init?.method })
    ) as typeof fetch;

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
      'Summary: checked=3, ok_200=3, failed=0, non_200=0, invalid_image=0, missing_url=0, invalid_url=0, network_errors=0, emoji_only=3',
    ]);
    expect(lines.join('\n')).not.toContain('https://');
  });

  it('supports existing raster formats (WebP, PNG, JPEG, GIF, AVIF) and HEAD 405/501 fallback to GET', async () => {
    const db = makeDb({
      products: [
        { name: 'Брынза', isCustom: true, imageUrl: 'https://cdn.example/feta.webp' },
        { name: 'Творог', isCustom: true, imageUrl: 'https://cdn.example/curd.png' },
        { name: 'Йогурт', isCustom: true, imageUrl: 'https://cdn.example/yogurt.jpg' },
        { name: 'Кефир', isCustom: true, imageUrl: 'https://cdn.example/kefir.gif' },
        { name: 'Сыр', isCustom: true, imageUrl: 'https://cdn.example/cheese.avif' },
      ],
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('.webp')) {
        if (init?.method === 'HEAD') return new Response(null, { status: 405 });
        return webpOkResponse();
      }
      if (url.endsWith('.png')) {
        return new Response(init?.method === 'HEAD' ? null : VALID_PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      if (url.endsWith('.jpg')) {
        return new Response(init?.method === 'HEAD' ? null : VALID_JPEG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (url.endsWith('.gif')) {
        return new Response(init?.method === 'HEAD' ? null : VALID_GIF_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/gif' },
        });
      }
      return new Response(init?.method === 'HEAD' ? null : VALID_AVIF_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/avif' },
      });
    }) as typeof fetch;

    const report = await auditCatalogPrimaryImages(db, { fetchImpl });

    expect(report.exitCode).toBe(0);
    expect(report.okCount).toBe(5);
    expect(report.failedCount).toBe(0);
  });

  it('rejects HEAD/GET mismatches, HTML 200, fake-MIME HTML, SVG, empty bodies, oversized responses, and stalled GET streams (B2)', async () => {
    const db = makeDb({
      products: [
        {
          name: 'MismatchedHead200Get404',
          isCustom: true,
          imageUrl: 'https://cdn.example/h200-g404',
        },
        {
          name: 'MismatchedHead404Get200',
          isCustom: true,
          imageUrl: 'https://cdn.example/h404-g200',
        },
        { name: 'Html200', isCustom: true, imageUrl: 'https://cdn.example/html-200' },
        { name: 'FakeWebpHtml', isCustom: true, imageUrl: 'https://cdn.example/fake-webp' },
        { name: 'EmptyBody', isCustom: true, imageUrl: 'https://cdn.example/empty-body' },
        { name: 'SvgImage', isCustom: true, imageUrl: 'https://cdn.example/icon.svg' },
        { name: 'TooLarge', isCustom: true, imageUrl: 'https://cdn.example/too-large' },
        { name: 'SlowBody', isCustom: true, imageUrl: 'https://cdn.example/slow-body' },
      ],
    });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('h200-g404')) {
        if (method === 'HEAD') {
          return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
        }
        return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      if (url.endsWith('h404-g200')) {
        if (method === 'HEAD') return new Response(null, { status: 404 });
        return webpOkResponse();
      }
      if (url.endsWith('html-200')) {
        return new Response(
          method === 'HEAD' ? null : '<!doctype html><html><body>err</body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }
        );
      }
      if (url.endsWith('fake-webp')) {
        return new Response(method === 'HEAD' ? null : '<html>not a webp</html>', {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        });
      }
      if (url.endsWith('empty-body')) {
        return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
      }
      if (url.endsWith('icon.svg')) {
        return new Response(method === 'HEAD' ? null : '<svg></svg>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        });
      }
      if (url.endsWith('too-large')) {
        if (method === 'HEAD') {
          return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
        }
        const oversized = new Uint8Array(256);
        oversized.set(VALID_WEBP_BYTES.subarray(0, 12), 0);
        return new Response(oversized, { status: 200, headers: { 'content-type': 'image/webp' } });
      }
      if (method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
      }
      const stalledStream = new ReadableStream<Uint8Array>({
        start() {
          // Intentionally never enqueue or close to exercise bounded GET timeout.
        },
      });
      return new Response(stalledStream, {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }) as typeof fetch;

    const report = await auditCatalogPrimaryImages(db, {
      fetchImpl,
      maxBytes: 128,
      timeoutMs: 40,
      concurrency: 4,
    });

    expect(report.exitCode).toBe(1);
    expect(report.okCount).toBe(0);
    expect(report.failedCount).toBe(8);
    expect(report.entries).toEqual([
      { kind: 'product', name: 'MismatchedHead200Get404', status: 'HEAD_GET_MISMATCH', ok: false },
      { kind: 'product', name: 'MismatchedHead404Get200', status: 'HEAD_GET_MISMATCH', ok: false },
      { kind: 'product', name: 'Html200', status: 'NOT_AN_IMAGE', ok: false },
      { kind: 'product', name: 'FakeWebpHtml', status: 'NOT_AN_IMAGE', ok: false },
      { kind: 'product', name: 'EmptyBody', status: 'NOT_AN_IMAGE', ok: false },
      { kind: 'product', name: 'SvgImage', status: 'NOT_AN_IMAGE', ok: false },
      { kind: 'product', name: 'TooLarge', status: 'BODY_TOO_LARGE', ok: false },
      { kind: 'product', name: 'SlowBody', status: 'TIMEOUT', ok: false },
    ]);
  });

  it('handles redirects safely and flags credentialed or excessive redirect chains', async () => {
    const credentialedImageUrl = new URL('https://cdn.example/a.webp');
    credentialedImageUrl.username = 'user';
    credentialedImageUrl.password = 'pass';

    const db = makeDb({
      products: [
        { name: 'ValidRedirect', isCustom: true, imageUrl: 'https://cdn.example/redir-ok' },
        { name: 'LoopRedirect', isCustom: true, imageUrl: 'https://cdn.example/redir-loop' },
        { name: 'CredentialUrl', isCustom: true, imageUrl: credentialedImageUrl.toString() },
      ],
    });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('redir-ok')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example/final.webp' },
        });
      }
      if (url.endsWith('final.webp')) {
        return webpOkResponse({ method: init?.method, url });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example/redir-loop' },
      });
    }) as typeof fetch;

    const report = await auditCatalogPrimaryImages(db, { fetchImpl });
    expect(report.exitCode).toBe(1);
    expect(report.entries).toEqual([
      { kind: 'product', name: 'ValidRedirect', status: 'HTTP 200', ok: true },
      { kind: 'product', name: 'LoopRedirect', status: 'NETWORK_ERROR', ok: false },
      { kind: 'product', name: 'CredentialUrl', status: 'INVALID_URL', ok: false },
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
          throw new Error('postgresql://user:secret@localhost/db failed');
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
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('ok.webp')
        ? webpOkResponse({ method: init?.method })
        : new Response(null, { status: 500 })
    ) as typeof fetch;

    const report = await auditCatalogPrimaryImages(db, { fetchImpl });
    const failuresOnly = formatAuditReportLines(report, { failuresOnly: true });
    expect(failuresOnly).toEqual([
      'Сбой: HTTP 500',
      'Summary: checked=2, ok_200=1, failed=1, non_200=1, invalid_image=0, missing_url=0, invalid_url=0, network_errors=0, emoji_only=0',
    ]);

    expect(parseAuditCliArgs(['--help'])).toEqual({ help: true, failuresOnly: false });
    expect(parseAuditCliArgs(['--failures-only'])).toEqual({ help: false, failuresOnly: true });
    expect(() => parseAuditCliArgs(['--unknown'])).toThrowError(SafeOperationalError);
  });
});
