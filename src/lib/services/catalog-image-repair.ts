import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_HTTP_CONCURRENCY,
  DEFAULT_HTTP_TIMEOUT_MS,
  type ImageProbeResult,
  isStorefrontImageUrl,
  mapWithConcurrency,
  normalizeCatalogName,
  parseSafeHttpUrl,
  probeImageUrl,
  probeOldBrokenImage,
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
  oldState?: 'PROVEN_MISSING' | 'STILL_PRESENT' | 'UNKNOWN';
  reason?: string;
  oldHttpStatus?: number | string;
  newHttpStatus?: number | string;
};

export type RepairItemDecision = {
  targetLabel: string;
  status:
    | 'READY'
    | 'CONFLICT'
    | 'ALREADY_APPLIED'
    | 'NOT_FOUND'
    | 'AMBIGUOUS'
    | 'UNKNOWN'
    | 'INVALID_URL'
    | 'HTTP_FAILED';
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
    if (!isNonEmptyString(newImageUrl) || !isStorefrontImageUrl(newImageUrl)) {
      throw new SafeOperationalError(
        'INVALID_PLAN',
        `Repair entry #${i + 1} "newImageUrl" must match the storefront CDN URL contract`
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

function formatNewProbeFailure(probe: Extract<ImageProbeResult, { ok: false }>): string {
  switch (probe.kind) {
    case 'INVALID_URL':
      return 'New URL is invalid or redirected to a disallowed URL';
    case 'HEAD_GET_MISMATCH':
      return `New URL had HEAD/GET mismatch (GET status ${probe.status ?? 'unknown'})`;
    case 'NOT_AN_IMAGE':
      return 'New URL did not return a valid raster image payload';
    case 'BODY_TOO_LARGE':
      return 'New URL response exceeded the bounded byte limit';
    case 'NON_200_HTTP':
      return `New URL returned HTTP ${probe.status ?? 'unknown'}; expected HTTP 200`;
    case 'TIMEOUT':
    case 'NETWORK_ERROR':
      return `New URL check failed (${probe.kind})`;
  }
}

export type RepairVerificationOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  concurrency?: number;
  requireHttps?: boolean;
  requireStorefrontUrl?: boolean;
};

function precheckRepairUrls(
  entries: readonly RepairPlanEntry[],
  options?: Pick<RepairVerificationOptions, 'requireHttps' | 'requireStorefrontUrl'>
): CurrencyCheckOutcome[] | null {
  const requireHttps = options?.requireHttps ?? true;
  const requireStorefrontUrl = options?.requireStorefrontUrl ?? true;

  const issues = entries.map((entry) => {
    const targetLabel = formatRepairTargetLabel(entry);
    const oldValid = Boolean(parseSafeHttpUrl(entry.expectedImageUrl, requireHttps));
    const newValid = requireStorefrontUrl
      ? isStorefrontImageUrl(entry.newImageUrl)
      : Boolean(parseSafeHttpUrl(entry.newImageUrl, requireHttps));

    if (!newValid) {
      return {
        targetLabel,
        invalid: true,
        outcome: {
          targetLabel,
          ok: false,
          newHttpStatus: 'INVALID_URL',
          reason: requireStorefrontUrl
            ? 'New URL violates storefront CDN URL contract (next.config.ts remotePatterns)'
            : 'New URL is invalid',
        } satisfies CurrencyCheckOutcome,
      };
    }

    if (!oldValid) {
      return {
        targetLabel,
        invalid: true,
        outcome: {
          targetLabel,
          ok: false,
          oldState: 'UNKNOWN',
          oldHttpStatus: 'INVALID_URL',
          reason: 'Old URL is invalid; treating status as UNKNOWN',
        } satisfies CurrencyCheckOutcome,
      };
    }

    return { targetLabel, invalid: false, outcome: null };
  });

  if (!issues.some((item) => item.invalid)) {
    return null;
  }

  return issues.map((item) =>
    item.outcome
      ? item.outcome
      : {
          targetLabel: item.targetLabel,
          ok: false,
          reason: 'Skipped HTTP check because another entry failed URL contract validation',
        }
  );
}

/**
 * Verifies live HTTP currency of every `(expectedImageUrl, newImageUrl)` pair before touching
 * the database: `newImageUrl` must match the storefront URL contract before any HTTP/DB call,
 * `expectedImageUrl` must return a proven missing status (consistent `404`/`410`, treating
 * transient/ambiguous statuses as `UNKNOWN`), and `newImageUrl` must pass a bounded actual `GET`
 * returning HTTP 200 with valid raster image bytes.
 */
export async function verifyRepairCurrency(
  entries: readonly RepairPlanEntry[],
  options?: RepairVerificationOptions
): Promise<CurrencyCheckOutcome[]> {
  const precheckFailure = precheckRepairUrls(entries, options);
  if (precheckFailure) {
    return precheckFailure;
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const requireHttps = options?.requireHttps ?? true;

  return mapWithConcurrency(
    entries,
    options?.concurrency ?? DEFAULT_HTTP_CONCURRENCY,
    async (entry): Promise<CurrencyCheckOutcome> => {
      const targetLabel = formatRepairTargetLabel(entry);
      const [oldProbe, newProbe] = await Promise.all([
        probeOldBrokenImage(entry.expectedImageUrl, { fetchImpl, timeoutMs, requireHttps }),
        probeImageUrl(entry.newImageUrl, {
          fetchImpl,
          timeoutMs,
          maxBytes: options?.maxBytes,
          requireHttps,
        }),
      ]);

      if (oldProbe.kind === 'STILL_PRESENT') {
        return {
          targetLabel,
          ok: false,
          oldState: 'STILL_PRESENT',
          oldHttpStatus: oldProbe.status,
          reason: 'Old URL still returns HTTP 200 on CDN; refusing overwrite',
        };
      }
      if (oldProbe.kind === 'UNKNOWN') {
        return {
          targetLabel,
          ok: false,
          oldState: 'UNKNOWN',
          oldHttpStatus: 'UNKNOWN',
          reason: oldProbe.reason,
        };
      }

      if (!newProbe.ok) {
        return {
          targetLabel,
          ok: false,
          oldState: 'PROVEN_MISSING',
          oldHttpStatus: oldProbe.status,
          newHttpStatus: newProbe.status ?? newProbe.kind,
          reason: formatNewProbeFailure(newProbe),
        };
      }

      return {
        targetLabel,
        ok: true,
        oldState: 'PROVEN_MISSING',
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

function decisionFromHttpFailure(item: CurrencyCheckOutcome): RepairItemDecision {
  if (item.newHttpStatus === 'INVALID_URL') {
    return {
      targetLabel: item.targetLabel,
      status: 'INVALID_URL',
      detail: item.reason ?? 'Replacement URL violates storefront contract',
    };
  }
  if (item.oldState === 'UNKNOWN') {
    return {
      targetLabel: item.targetLabel,
      status: 'UNKNOWN',
      detail: item.reason ?? 'Old URL status is UNKNOWN; refusing overwrite',
    };
  }
  return {
    targetLabel: item.targetLabel,
    status: 'HTTP_FAILED',
    detail: item.reason ?? 'HTTP currency check failed',
  };
}

/**
 * Dry-run check: validates storefront URL contract before HTTP/DB, verifies HTTP currency, and
 * checks read-only DB preconditions without writing anything.
 */
export async function dryRunCatalogImageRepairs(
  db: RepairDbClient,
  entries: readonly RepairPlanEntry[],
  options?: RepairVerificationOptions
): Promise<RepairRunResult> {
  const precheckFailure = precheckRepairUrls(entries, options);
  if (precheckFailure) {
    return {
      mode: 'dry-run',
      plannedCount: entries.length,
      updatedCount: 0,
      decisions: precheckFailure.map(decisionFromHttpFailure),
      exitCode: 1,
    };
  }

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
      return decisionFromHttpFailure(httpCheck);
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
 * Applies all repair pairs atomically inside a single Serializable transaction. Any storefront URL
 * contract violation, HTTP currency check failure, UNKNOWN old-URL status, missing/ambiguous
 * target, or concurrent edit (`count !== 1`) aborts and rolls back every update in the transaction
 * so partial apply is impossible.
 */
export async function applyCatalogImageRepairs(
  prisma: Pick<PrismaClient, '$transaction'>,
  entries: readonly RepairPlanEntry[],
  options?: RepairVerificationOptions & {
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
      decisions: currency.map((item) =>
        item.ok
          ? {
              targetLabel: item.targetLabel,
              status: 'READY',
              detail: 'HTTP currency verified',
            }
          : decisionFromHttpFailure(item)
      ),
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
