import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_HTTP_CONCURRENCY,
  DEFAULT_HTTP_TIMEOUT_MS,
  mapWithConcurrency,
  normalizeCatalogName,
  parseSafeHttpUrl,
  probeImageUrl,
  SafeOperationalError,
} from './catalog-image-http';

export type RepairTargetKind = 'product' | 'category' | 'variant';

export type RepairPlanEntry = {
  target: RepairTargetKind;
  name: string;
  category?: string;
  parent?: string;
  expectedImageUrl: string;
  expectedIsCustom?: boolean;
  newImageUrl: string;
};

export type CurrencyCheckOutcome = {
  targetLabel: string;
  ok: boolean;
  reason?: string;
  oldHttpStatus?: number | string;
  newHttpStatus?: number | string;
};

export type RepairItemDecision = {
  targetLabel: string;
  status: 'READY' | 'CONFLICT' | 'ALREADY_APPLIED' | 'NOT_FOUND' | 'AMBIGUOUS' | 'HTTP_FAILED';
  detail: string;
};

export type RepairRunResult = {
  mode: 'dry-run' | 'apply';
  plannedCount: number;
  updatedCount: number;
  decisions: RepairItemDecision[];
  exitCode: 0 | 1;
};

const ALLOWED_KEYS = new Set([
  'target',
  'name',
  'category',
  'parent',
  'expectedImageUrl',
  'expectedIsCustom',
  'newImageUrl',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function formatRepairTargetLabel(entry: RepairPlanEntry): string {
  if (entry.target === 'category') return `[category] ${entry.name}`;
  if (entry.target === 'variant') {
    return `[variant] ${entry.category} / ${entry.parent} / ${entry.name}`;
  }
  return `[product] ${entry.category} / ${entry.name}`;
}

function targetIdentityKey(entry: RepairPlanEntry): string {
  return [
    entry.target,
    normalizeCatalogName(entry.category ?? ''),
    normalizeCatalogName(entry.parent ?? ''),
    normalizeCatalogName(entry.name),
  ].join('|');
}

/**
 * Validates a repair plan JSON payload containing proven `(old -> new)` primary image pairs.
 * Fails closed on unknown fields, duplicate targets, missing preconditions, or invalid URLs.
 */
export function parseRepairPlan(raw: unknown): RepairPlanEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SafeOperationalError('INVALID_PLAN', 'Plan root must be a JSON object');
  }
  const root = raw as Record<string, unknown>;
  const rootKeys = Object.keys(root);
  if (rootKeys.length !== 1 || rootKeys[0] !== 'repairs') {
    throw new SafeOperationalError('INVALID_PLAN', 'Plan root must contain only "repairs"');
  }
  if (!Array.isArray(root.repairs) || root.repairs.length === 0) {
    throw new SafeOperationalError('INVALID_PLAN', '"repairs" must be a non-empty array');
  }

  const seen = new Set<string>();
  const entries: RepairPlanEntry[] = [];

  for (let i = 0; i < root.repairs.length; i++) {
    const rawEntry = root.repairs[i];
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new SafeOperationalError('INVALID_PLAN', `Repair entry #${i + 1} must be an object`);
    }
    const obj = rawEntry as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new SafeOperationalError(
          'INVALID_PLAN',
          `Repair entry #${i + 1} contains unknown field`
        );
      }
    }

    const { target, name, category, parent, expectedImageUrl, expectedIsCustom, newImageUrl } = obj;
    if (target !== 'product' && target !== 'category' && target !== 'variant') {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} has invalid target kind`
      );
    }
    if (!isNonEmptyString(name)) {
      throw new SafeOperationalError('INVALID_PLAN', `Repair entry #${i + 1} requires "name"`);
    }
    if ((target === 'product' || target === 'variant') && !isNonEmptyString(category)) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} requires "category" for ${target}`
      );
    }
    if (target === 'category' && category !== undefined) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} must not set "category" for category target`
      );
    }
    if (target === 'variant' && !isNonEmptyString(parent)) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} requires "parent" for variant`
      );
    }
    if (target !== 'variant' && parent !== undefined) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} must not set "parent" for ${target}`
      );
    }
    if (target !== 'variant' && typeof expectedIsCustom !== 'boolean') {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} requires boolean "expectedIsCustom"`
      );
    }
    if (target === 'variant' && expectedIsCustom !== undefined) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} must not set "expectedIsCustom" for variant`
      );
    }
    if (!isNonEmptyString(expectedImageUrl) || !parseSafeHttpUrl(expectedImageUrl, true)) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} requires an https "expectedImageUrl"`
      );
    }
    if (!isNonEmptyString(newImageUrl) || !parseSafeHttpUrl(newImageUrl, true)) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} requires an https "newImageUrl"`
      );
    }
    if (expectedImageUrl === newImageUrl) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} expectedImageUrl and newImageUrl must differ`
      );
    }

    const entry: RepairPlanEntry = {
      target,
      name: name.trim(),
      ...(typeof category === 'string' && { category: category.trim() }),
      ...(typeof parent === 'string' && { parent: parent.trim() }),
      expectedImageUrl,
      ...(typeof expectedIsCustom === 'boolean' && { expectedIsCustom }),
      newImageUrl,
    };

    const key = targetIdentityKey(entry);
    if (seen.has(key)) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Duplicate target in plan: ${formatRepairTargetLabel(entry)}`
      );
    }
    seen.add(key);
    entries.push(entry);
  }

  return entries;
}

/**
 * Verifies live HTTP currency of every `(expectedImageUrl, newImageUrl)` pair before touching
 * the database: `expectedImageUrl` must respond with an explicit non-200 HTTP status, and
 * `newImageUrl` must respond with HTTP 200 and an `image/*` content type.
 */
export async function verifyRepairCurrency(
  entries: readonly RepairPlanEntry[],
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    concurrency?: number;
    requireHttps?: boolean;
  }
): Promise<CurrencyCheckOutcome[]> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const requireHttps = options?.requireHttps ?? true;

  return mapWithConcurrency(
    entries,
    options?.concurrency ?? DEFAULT_HTTP_CONCURRENCY,
    async (entry): Promise<CurrencyCheckOutcome> => {
      const targetLabel = formatRepairTargetLabel(entry);
      const [oldProbe, newProbe] = await Promise.all([
        probeImageUrl(entry.expectedImageUrl, { fetchImpl, timeoutMs, requireHttps }),
        probeImageUrl(entry.newImageUrl, { fetchImpl, timeoutMs, requireHttps }),
      ]);

      if (!oldProbe.ok) {
        return {
          targetLabel,
          ok: false,
          oldHttpStatus: oldProbe.kind,
          reason: `Old URL check failed (${oldProbe.kind}); refusing to assume it is broken`,
        };
      }
      if (oldProbe.status === 200) {
        return {
          targetLabel,
          ok: false,
          oldHttpStatus: oldProbe.status,
          reason: 'Old URL still returns HTTP 200 on CDN; refusing overwrite',
        };
      }

      if (!newProbe.ok) {
        return {
          targetLabel,
          ok: false,
          oldHttpStatus: oldProbe.status,
          newHttpStatus: newProbe.kind,
          reason: `New URL check failed (${newProbe.kind})`,
        };
      }
      if (newProbe.status !== 200) {
        return {
          targetLabel,
          ok: false,
          oldHttpStatus: oldProbe.status,
          newHttpStatus: newProbe.status,
          reason: `New URL returned HTTP ${newProbe.status}; expected HTTP 200`,
        };
      }
      if (!newProbe.contentType || !newProbe.contentType.toLowerCase().startsWith('image/')) {
        return {
          targetLabel,
          ok: false,
          oldHttpStatus: oldProbe.status,
          newHttpStatus: newProbe.status,
          reason: 'New URL did not return an image/* Content-Type',
        };
      }

      return {
        targetLabel,
        ok: true,
        oldHttpStatus: oldProbe.status,
        newHttpStatus: newProbe.status,
      };
    }
  );
}

type CatalogSnapshotRow = {
  categories: Array<{ id: string; name: string; imageUrl: string | null; isCustom: boolean }>;
  products: Array<{
    id: string;
    name: string;
    categoryId: string;
    imageUrl: string | null;
    isCustom: boolean;
  }>;
  variants: Array<{ id: string; name: string; productId: string; imageUrl: string | null }>;
};

export type RepairDbClient = Pick<PrismaClient, 'category' | 'product' | 'productVariant'> & {
  $transaction?: PrismaClient['$transaction'];
};

async function loadRepairTargetsSnapshot(
  db: Pick<PrismaClient, 'category' | 'product' | 'productVariant'>
): Promise<CatalogSnapshotRow> {
  const [categories, products, variants] = await Promise.all([
    db.category.findMany({ select: { id: true, name: true, imageUrl: true, isCustom: true } }),
    db.product.findMany({
      where: { isGlobal: true },
      select: { id: true, name: true, categoryId: true, imageUrl: true, isCustom: true },
    }),
    db.productVariant.findMany({
      where: { product: { isGlobal: true } },
      select: { id: true, name: true, productId: true, imageUrl: true },
    }),
  ]);
  return { categories, products, variants };
}

type ResolvedTarget =
  | {
      kind: 'ok';
      target: 'product';
      id: string;
      imageUrl: string | null;
      isCustom: boolean;
    }
  | {
      kind: 'ok';
      target: 'category';
      id: string;
      imageUrl: string | null;
      isCustom: boolean;
    }
  | {
      kind: 'ok';
      target: 'variant';
      id: string;
      imageUrl: string | null;
    }
  | { kind: 'error'; status: 'NOT_FOUND' | 'AMBIGUOUS'; detail: string };

function resolveTarget(entry: RepairPlanEntry, snapshot: CatalogSnapshotRow): ResolvedTarget {
  if (entry.target === 'category') {
    const matches = snapshot.categories.filter(
      (cat) => normalizeCatalogName(cat.name) === normalizeCatalogName(entry.name)
    );
    if (matches.length === 0)
      return { kind: 'error', status: 'NOT_FOUND', detail: 'Category missing' };
    if (matches.length > 1) {
      return { kind: 'error', status: 'AMBIGUOUS', detail: 'Multiple categories match name' };
    }
    const cat = matches[0]!;
    return {
      kind: 'ok',
      target: 'category',
      id: cat.id,
      imageUrl: cat.imageUrl,
      isCustom: cat.isCustom,
    };
  }

  const categoryMatches = snapshot.categories.filter(
    (cat) => normalizeCatalogName(cat.name) === normalizeCatalogName(entry.category ?? '')
  );
  if (categoryMatches.length === 0) {
    return { kind: 'error', status: 'NOT_FOUND', detail: 'Category missing' };
  }
  if (categoryMatches.length > 1) {
    return { kind: 'error', status: 'AMBIGUOUS', detail: 'Multiple categories match name' };
  }
  const category = categoryMatches[0]!;

  if (entry.target === 'product') {
    const matches = snapshot.products.filter(
      (prod) =>
        prod.categoryId === category.id &&
        normalizeCatalogName(prod.name) === normalizeCatalogName(entry.name)
    );
    if (matches.length === 0) {
      return { kind: 'error', status: 'NOT_FOUND', detail: 'Product missing in category' };
    }
    if (matches.length > 1) {
      return { kind: 'error', status: 'AMBIGUOUS', detail: 'Multiple products match in category' };
    }
    const prod = matches[0]!;
    return {
      kind: 'ok',
      target: 'product',
      id: prod.id,
      imageUrl: prod.imageUrl,
      isCustom: prod.isCustom,
    };
  }

  const parentMatches = snapshot.products.filter(
    (prod) =>
      prod.categoryId === category.id &&
      normalizeCatalogName(prod.name) === normalizeCatalogName(entry.parent ?? '')
  );
  if (parentMatches.length === 0) {
    return { kind: 'error', status: 'NOT_FOUND', detail: 'Variant parent product missing' };
  }
  if (parentMatches.length > 1) {
    return { kind: 'error', status: 'AMBIGUOUS', detail: 'Multiple parent products match' };
  }
  const parent = parentMatches[0]!;
  const variantMatches = snapshot.variants.filter(
    (variant) =>
      variant.productId === parent.id &&
      normalizeCatalogName(variant.name) === normalizeCatalogName(entry.name)
  );
  if (variantMatches.length === 0) {
    return { kind: 'error', status: 'NOT_FOUND', detail: 'Variant missing under parent product' };
  }
  if (variantMatches.length > 1) {
    return { kind: 'error', status: 'AMBIGUOUS', detail: 'Multiple variants match under parent' };
  }
  const variant = variantMatches[0]!;
  return { kind: 'ok', target: 'variant', id: variant.id, imageUrl: variant.imageUrl };
}

function evaluatePrecondition(
  entry: RepairPlanEntry,
  resolved: ResolvedTarget
): RepairItemDecision {
  const targetLabel = formatRepairTargetLabel(entry);
  if (resolved.kind === 'error') {
    return { targetLabel, status: resolved.status, detail: resolved.detail };
  }

  if (resolved.target === 'variant') {
    if (resolved.imageUrl === entry.newImageUrl) {
      return {
        targetLabel,
        status: 'ALREADY_APPLIED',
        detail: 'Current imageUrl already holds the target replacement',
      };
    }
    if (resolved.imageUrl !== entry.expectedImageUrl) {
      return {
        targetLabel,
        status: 'CONFLICT',
        detail: 'Current imageUrl differs from expectedImageUrl',
      };
    }
    return { targetLabel, status: 'READY', detail: 'Precondition matched' };
  }

  if (resolved.imageUrl === entry.newImageUrl && resolved.isCustom === true) {
    return {
      targetLabel,
      status: 'ALREADY_APPLIED',
      detail: 'Current primary image already holds the target replacement',
    };
  }
  if (
    resolved.imageUrl !== entry.expectedImageUrl ||
    resolved.isCustom !== entry.expectedIsCustom
  ) {
    return {
      targetLabel,
      status: 'CONFLICT',
      detail: 'Current imageUrl or isCustom differs from expected precondition',
    };
  }
  return { targetLabel, status: 'READY', detail: 'Precondition matched' };
}

/**
 * Dry-run check: verifies HTTP currency and read-only DB preconditions without writing anything.
 */
export async function dryRunCatalogImageRepairs(
  db: RepairDbClient,
  entries: readonly RepairPlanEntry[],
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    concurrency?: number;
    requireHttps?: boolean;
  }
): Promise<RepairRunResult> {
  const currency = await verifyRepairCurrency(entries, options);
  const currencyByLabel = new Map(currency.map((item) => [item.targetLabel, item]));

  const snapshot =
    typeof db.$transaction === 'function'
      ? await db.$transaction(async (tx) => {
          const maybeRaw = tx as unknown as {
            $executeRawUnsafe?: (sql: string) => Promise<unknown>;
          };
          if (typeof maybeRaw.$executeRawUnsafe === 'function') {
            await maybeRaw.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          }
          return loadRepairTargetsSnapshot(tx);
        })
      : await loadRepairTargetsSnapshot(db);

  const decisions: RepairItemDecision[] = entries.map((entry) => {
    const label = formatRepairTargetLabel(entry);
    const httpCheck = currencyByLabel.get(label)!;
    const resolved = resolveTarget(entry, snapshot);
    const dbCheck = evaluatePrecondition(entry, resolved);

    if (!httpCheck.ok) {
      return {
        targetLabel: label,
        status: 'HTTP_FAILED',
        detail: httpCheck.reason ?? 'HTTP currency check failed',
      };
    }
    return dbCheck;
  });

  const allReady = decisions.every((d) => d.status === 'READY');
  return {
    mode: 'dry-run',
    plannedCount: entries.length,
    updatedCount: 0,
    decisions,
    exitCode: allReady ? 0 : 1,
  };
}

/**
 * Applies all repair pairs atomically inside a single Serializable transaction. Any currency
 * check failure, missing/ambiguous target, or concurrent edit (`count !== 1`) aborts and rolls
 * back every update in the transaction so partial apply is impossible.
 */
export async function applyCatalogImageRepairs(
  prisma: Pick<PrismaClient, '$transaction'>,
  entries: readonly RepairPlanEntry[],
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    concurrency?: number;
    requireHttps?: boolean;
    beforeWriteHook?: () => Promise<void>;
  }
): Promise<RepairRunResult> {
  const currency = await verifyRepairCurrency(entries, options);
  const failedHttp = currency.filter((item) => !item.ok);
  if (failedHttp.length > 0) {
    return {
      mode: 'apply',
      plannedCount: entries.length,
      updatedCount: 0,
      decisions: currency.map((item) => ({
        targetLabel: item.targetLabel,
        status: item.ok ? 'READY' : 'HTTP_FAILED',
        detail: item.ok ? 'HTTP currency verified' : (item.reason ?? 'HTTP currency check failed'),
      })),
      exitCode: 1,
    };
  }

  try {
    const decisions = await prisma.$transaction(
      async (tx) => {
        const maybeRaw = tx as unknown as {
          $executeRawUnsafe?: (sql: string) => Promise<unknown>;
        };
        if (typeof maybeRaw.$executeRawUnsafe === 'function') {
          await maybeRaw.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
        }

        const snapshot = await loadRepairTargetsSnapshot(tx);
        const resolvedList = entries.map((entry) => ({
          entry,
          resolved: resolveTarget(entry, snapshot),
        }));

        for (const { entry, resolved } of resolvedList) {
          const decision = evaluatePrecondition(entry, resolved);
          if (decision.status !== 'READY') {
            throw new SafeOperationalError(
              'REPAIR_PRECONDITION_FAILED',
              `${decision.targetLabel}: ${decision.detail}`
            );
          }
        }

        if (options?.beforeWriteHook) {
          await options.beforeWriteHook();
        }

        let updatedCount = 0;
        const itemDecisions: RepairItemDecision[] = [];

        for (const { entry, resolved } of resolvedList) {
          if (resolved.kind !== 'ok') {
            throw new SafeOperationalError('REPAIR_PRECONDITION_FAILED', 'Unresolved target');
          }

          let count = 0;
          if (resolved.target === 'product') {
            const result = await tx.product.updateMany({
              where: {
                id: resolved.id,
                isGlobal: true,
                imageUrl: entry.expectedImageUrl,
                isCustom: entry.expectedIsCustom!,
              },
              data: {
                imageUrl: entry.newImageUrl,
                isCustom: true,
              },
            });
            count = result.count;
          } else if (resolved.target === 'category') {
            const result = await tx.category.updateMany({
              where: {
                id: resolved.id,
                imageUrl: entry.expectedImageUrl,
                isCustom: entry.expectedIsCustom!,
              },
              data: {
                imageUrl: entry.newImageUrl,
                isCustom: true,
              },
            });
            count = result.count;
          } else {
            const result = await tx.productVariant.updateMany({
              where: {
                id: resolved.id,
                imageUrl: entry.expectedImageUrl,
              },
              data: {
                imageUrl: entry.newImageUrl,
              },
            });
            count = result.count;
          }

          if (count !== 1) {
            throw new SafeOperationalError(
              'CONCURRENT_MODIFICATION',
              `${formatRepairTargetLabel(entry)}: conditional update matched ${count} rows; rolled back`
            );
          }

          updatedCount += count;
          itemDecisions.push({
            targetLabel: formatRepairTargetLabel(entry),
            status: 'READY',
            detail: 'Updated primary image field atomically',
          });
        }

        if (updatedCount !== entries.length) {
          throw new SafeOperationalError(
            'PARTIAL_APPLY_ABORTED',
            `Expected ${entries.length} updated rows, got ${updatedCount}; rolled back`
          );
        }

        return itemDecisions;
      },
      { isolationLevel: 'Serializable', timeout: 30_000 }
    );

    return {
      mode: 'apply',
      plannedCount: entries.length,
      updatedCount: entries.length,
      decisions,
      exitCode: 0,
    };
  } catch (error) {
    const code =
      error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (error instanceof SafeOperationalError) {
      return {
        mode: 'apply',
        plannedCount: entries.length,
        updatedCount: 0,
        decisions: [
          {
            targetLabel: 'transaction',
            status: 'CONFLICT',
            detail: error.message,
          },
        ],
        exitCode: 1,
      };
    }
    if (code === 'P2034') {
      return {
        mode: 'apply',
        plannedCount: entries.length,
        updatedCount: 0,
        decisions: [
          {
            targetLabel: 'transaction',
            status: 'CONFLICT',
            detail: 'Concurrent catalog update detected (serialization conflict); rolled back',
          },
        ],
        exitCode: 1,
      };
    }
    throw error;
  }
}

export type RepairCliOptions = {
  help: boolean;
  apply: boolean;
  planPath?: string;
};

/**
 * Parses CLI flags for `scripts/repair-catalog-images.ts`.
 */
export function parseRepairCliArgs(argv: readonly string[]): RepairCliOptions {
  let help = false;
  let apply = false;
  let planPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--plan') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new SafeOperationalError('INVALID_ARGUMENT', 'Option --plan requires a file path');
      }
      planPath = value;
      i++;
    } else {
      throw new SafeOperationalError('INVALID_ARGUMENT', 'Unknown CLI argument');
    }
  }

  return { help, apply, planPath };
}
