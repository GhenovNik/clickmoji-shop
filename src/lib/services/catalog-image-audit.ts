import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_HTTP_CONCURRENCY,
  DEFAULT_HTTP_TIMEOUT_MS,
  mapWithConcurrency,
  probeImageUrl,
  SafeOperationalError,
} from './catalog-image-http';

export type CatalogAuditTargetKind = 'category' | 'product' | 'variant';

export type CatalogAuditStatus =
  `HTTP ${number}` | 'MISSING_URL' | 'INVALID_URL' | 'TIMEOUT' | 'NETWORK_ERROR';

export type CatalogAuditEntry = {
  kind: CatalogAuditTargetKind;
  name: string;
  status: CatalogAuditStatus;
  ok: boolean;
};

export type CatalogAuditReport = {
  totalCatalogRecords: number;
  withoutUrlCount: number;
  checkedCount: number;
  okCount: number;
  failedCount: number;
  missingUrlCount: number;
  invalidUrlCount: number;
  non200HttpCount: number;
  networkErrorCount: number;
  entries: CatalogAuditEntry[];
  exitCode: 0 | 1;
};

export type CatalogAuditDbReader = {
  category: {
    findMany: (args: {
      select: { name: true; isCustom: true; imageUrl: true };
      orderBy: { order: 'asc' };
    }) => Promise<Array<{ name: string; isCustom: boolean; imageUrl: string | null }>>;
  };
  product: {
    findMany: (args: {
      where: { isGlobal: true };
      select: { name: true; isCustom: true; imageUrl: true };
      orderBy: { name: 'asc' };
    }) => Promise<Array<{ name: string; isCustom: boolean; imageUrl: string | null }>>;
  };
  productVariant: {
    findMany: (args: {
      where: { product: { isGlobal: true } };
      select: { name: true; imageUrl: true; product: { select: { name: true } } };
      orderBy: Array<{ product: { name: 'asc' } } | { name: 'asc' }>;
    }) => Promise<Array<{ name: string; imageUrl: string | null; product: { name: string } }>>;
  };
  $transaction?: PrismaClient['$transaction'];
};

type AuditWorkItem =
  | { kind: CatalogAuditTargetKind; name: string; missingUrl: true }
  | { kind: CatalogAuditTargetKind; name: string; missingUrl: false; url: string };

function sanitizeDisplayName(value: string): string {
  return value.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim() || '(unnamed)';
}

async function readCatalogPrimaryRows(db: CatalogAuditDbReader) {
  const runRead = async (reader: CatalogAuditDbReader) => {
    const [categories, products, variants] = await Promise.all([
      reader.category.findMany({
        select: { name: true, isCustom: true, imageUrl: true },
        orderBy: { order: 'asc' },
      }),
      reader.product.findMany({
        where: { isGlobal: true },
        select: { name: true, isCustom: true, imageUrl: true },
        orderBy: { name: 'asc' },
      }),
      reader.productVariant.findMany({
        where: { product: { isGlobal: true } },
        select: { name: true, imageUrl: true, product: { select: { name: true } } },
        orderBy: [{ product: { name: 'asc' } }, { name: 'asc' }],
      }),
    ]);
    return { categories, products, variants };
  };

  if (typeof db.$transaction === 'function') {
    return db.$transaction(async (tx) => {
      const maybeRaw = tx as unknown as {
        $executeRawUnsafe?: (sql: string) => Promise<unknown>;
      };
      if (typeof maybeRaw.$executeRawUnsafe === 'function') {
        await maybeRaw.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      }
      return runRead(tx as unknown as CatalogAuditDbReader);
    });
  }

  return runRead(db);
}

/**
 * Audits all primary image URLs (`imageUrl`) across categories, global products, and global
 * product variants. Requires HTTP 200 for every present URL and flags `isCustom: true` rows
 * with missing URLs. Never outputs raw URLs, database values, or unhandled exceptions.
 */
export async function auditCatalogPrimaryImages(
  db: CatalogAuditDbReader,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    concurrency?: number;
  }
): Promise<CatalogAuditReport> {
  let rows: Awaited<ReturnType<typeof readCatalogPrimaryRows>>;
  try {
    rows = await readCatalogPrimaryRows(db);
  } catch (error) {
    if (error instanceof SafeOperationalError) throw error;
    throw new SafeOperationalError(
      'DATABASE_READ_FAILED',
      'Failed to read catalog primary image records'
    );
  }

  const totalCatalogRecords = rows.categories.length + rows.products.length + rows.variants.length;
  if (totalCatalogRecords === 0) {
    throw new SafeOperationalError('EMPTY_CATALOG', 'Catalog contains no records to audit');
  }

  const queue: AuditWorkItem[] = [];
  let withoutUrlCount = 0;

  const enqueue = (
    kind: CatalogAuditTargetKind,
    name: string,
    imageUrl: string | null,
    requireUrl: boolean
  ) => {
    const trimmed = typeof imageUrl === 'string' ? imageUrl.trim() : '';
    if (trimmed.length > 0) {
      queue.push({ kind, name: sanitizeDisplayName(name), missingUrl: false, url: imageUrl! });
      return;
    }
    if (requireUrl) {
      queue.push({ kind, name: sanitizeDisplayName(name), missingUrl: true });
      return;
    }
    withoutUrlCount++;
  };

  for (const category of rows.categories) {
    enqueue('category', category.name, category.imageUrl, category.isCustom);
  }
  for (const product of rows.products) {
    enqueue('product', product.name, product.imageUrl, product.isCustom);
  }
  for (const variant of rows.variants) {
    enqueue('variant', `${variant.product.name} / ${variant.name}`, variant.imageUrl, false);
  }

  const entries = await mapWithConcurrency(
    queue,
    options?.concurrency ?? DEFAULT_HTTP_CONCURRENCY,
    async (item): Promise<CatalogAuditEntry> => {
      if (item.missingUrl) {
        return { kind: item.kind, name: item.name, status: 'MISSING_URL', ok: false };
      }
      const probe = await probeImageUrl(item.url, {
        fetchImpl: options?.fetchImpl,
        timeoutMs: options?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
      });
      if (!probe.ok) {
        return { kind: item.kind, name: item.name, status: probe.kind, ok: false };
      }
      const status: CatalogAuditStatus = `HTTP ${probe.status}`;
      return {
        kind: item.kind,
        name: item.name,
        status,
        ok: probe.status === 200,
      };
    }
  );

  let okCount = 0;
  let missingUrlCount = 0;
  let invalidUrlCount = 0;
  let non200HttpCount = 0;
  let networkErrorCount = 0;

  for (const entry of entries) {
    if (entry.ok) {
      okCount++;
    } else if (entry.status === 'MISSING_URL') {
      missingUrlCount++;
    } else if (entry.status === 'INVALID_URL') {
      invalidUrlCount++;
    } else if (entry.status === 'TIMEOUT' || entry.status === 'NETWORK_ERROR') {
      networkErrorCount++;
    } else {
      non200HttpCount++;
    }
  }

  const failedCount = entries.length - okCount;
  const exitCode: 0 | 1 = failedCount > 0 ? 1 : 0;

  return {
    totalCatalogRecords,
    withoutUrlCount,
    checkedCount: entries.length,
    okCount,
    failedCount,
    missingUrlCount,
    invalidUrlCount,
    non200HttpCount,
    networkErrorCount,
    entries,
    exitCode,
  };
}

/**
 * Formats an audit report as safe text lines containing only item names, HTTP/status codes, and
 * aggregate counts.
 */
export function formatAuditReportLines(
  report: CatalogAuditReport,
  options?: { failuresOnly?: boolean }
): string[] {
  const failuresOnly = options?.failuresOnly ?? false;
  const lines: string[] = [];

  for (const entry of report.entries) {
    if (failuresOnly && entry.ok) continue;
    const prefix = entry.kind === 'product' ? '' : `[${entry.kind}] `;
    lines.push(`${prefix}${entry.name}: ${entry.status}`);
  }

  lines.push(
    `Summary: checked=${report.checkedCount}, ok_200=${report.okCount}, failed=${report.failedCount}, ` +
      `non_200=${report.non200HttpCount}, missing_url=${report.missingUrlCount}, ` +
      `invalid_url=${report.invalidUrlCount}, network_errors=${report.networkErrorCount}, ` +
      `emoji_only=${report.withoutUrlCount}`
  );

  return lines;
}

export type AuditCliOptions = {
  help: boolean;
  failuresOnly: boolean;
};

/**
 * Parses CLI flags for `scripts/audit-catalog-images.ts`.
 */
export function parseAuditCliArgs(argv: readonly string[]): AuditCliOptions {
  let help = false;
  let failuresOnly = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--failures-only') {
      failuresOnly = true;
    } else {
      throw new SafeOperationalError('INVALID_ARGUMENT', 'Unknown CLI argument');
    }
  }

  return { help, failuresOnly };
}
