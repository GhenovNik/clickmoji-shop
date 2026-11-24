import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import type { BatchKind, ManifestBatch } from './emoji-batch-import';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../../..');

function cellRef(batch: string, cell: number) {
  return `${batch}#${cell}`;
}

function normalizeCatalogName(value: string) {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

export const DEFAULT_MANIFEST_PATH = 'docs/emoji-batches/manifest.json';
export const DEFAULT_CANDIDATES_PATH = 'docs/emoji-batches/candidates.json';
export const EXPECTED_LEGACY_TARGET_COUNT = 11;

const UNIVERSAL_BATCH_RE = /^batch-\d+$/;
const TEXT_BATCH_RE = /^text-\d+$/;
const TEXT_CELL_REF_RE = /^text-\d+#\d+$/;

export type LegacyRussianTarget = {
  ref: string;
  batch: string;
  cell: number;
  name: string;
  nameEn: string;
  category: string;
  supersededBy: string;
};

export type LibraryRow = {
  id: string;
  name: string;
  nameEn: string | null;
  source: string;
  sourceRef: string | null;
  locale: string | null;
  groupKey: string | null;
};

export type LibraryUpdateOp = {
  id: string;
  sourceRef: string | null;
  data: {
    locale?: 'ru';
    groupKey?: string;
  };
};

export type PlannedLegacyRussianItem = {
  ref: string;
  name: string;
  supersededBy: string;
  paired: boolean;
  enId: string | null;
  enSourceRef: string | null;
  ruLocaleFrom: string | null;
  ruLocaleTo: 'ru';
  ruGroupKeyFrom: string | null;
  ruGroupKeyTo: string | null;
  enGroupKeyFrom: string | null;
  enGroupKeyTo: string | null;
  targetGroupKey: string | null;
  changed: boolean;
};

export type LegacyRussianPlan = {
  totalLibraryCount: number;
  items: PlannedLegacyRussianItem[];
  operations: LibraryUpdateOp[];
};

export type LegacyRussianApplyResult = {
  plan: LegacyRussianPlan;
  totalLibraryCountAfter: number;
  appliedUpdates: number;
};

const LIBRARY_SELECT = {
  id: true,
  name: true,
  nameEn: true,
  source: true,
  sourceRef: true,
  locale: true,
  groupKey: true,
} as const;

export type LibraryDbReader = {
  emojiLibraryItem: {
    count: () => Promise<number>;
    findMany: (args: {
      where?: { sourceRef?: { in: string[] }; groupKey?: { in: string[] } };
      select: typeof LIBRARY_SELECT;
    }) => Promise<LibraryRow[]>;
  };
};

export type LibraryTxClient = {
  emojiLibraryItem: LibraryDbReader['emojiLibraryItem'] & {
    update: (args: { where: { id: string }; data: LibraryUpdateOp['data'] }) => Promise<unknown>;
  };
};

export type CliOptions = {
  apply: boolean;
  help: boolean;
  manifestPath: string;
  candidatesPath: string;
};

type CandidateEntry = {
  category: string;
  name: string;
  nameEn: string;
  text?: boolean;
};

type CandidatesFile = {
  redo: CandidateEntry[];
  categories: Array<{
    category: string;
    products: Array<Omit<CandidateEntry, 'category'>>;
  }>;
};

type IndexedCandidate = {
  category: string;
  name: string;
  nameEn: string;
  text: boolean;
};

function readJsonFile(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} file "${path}": ${message}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${label} file "${path}": ${message}`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseCandidates(raw: unknown): Map<string, IndexedCandidate> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid candidates file: expected a JSON object');
  }
  const file = raw as Partial<CandidatesFile>;
  if (!Array.isArray(file.redo) || !Array.isArray(file.categories)) {
    throw new Error('Invalid candidates file: expected "redo" and "categories" arrays');
  }

  const byName = new Map<string, IndexedCandidate>();
  const register = (item: unknown, categoryOverride?: string) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid candidate entry: expected an object');
    }
    const candidate = item as Record<string, unknown>;
    const category = categoryOverride ?? candidate.category;
    if (
      !isNonEmptyString(category) ||
      !isNonEmptyString(candidate.name) ||
      !isNonEmptyString(candidate.nameEn)
    ) {
      throw new Error('Invalid candidate entry: missing category, name, or nameEn');
    }
    if (candidate.text !== undefined && typeof candidate.text !== 'boolean') {
      throw new Error(`Invalid candidate "${candidate.name}": "text" must be a boolean`);
    }
    const key = normalizeCatalogName(candidate.name);
    if (byName.has(key)) {
      throw new Error(`Duplicate candidate "${candidate.name}" in candidates file`);
    }
    byName.set(key, {
      category,
      name: candidate.name,
      nameEn: candidate.nameEn,
      text: candidate.text === true,
    });
  };

  for (const item of file.redo) {
    register(item);
  }
  for (const group of file.categories) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error('Invalid category group in candidates file');
    }
    const groupObj = group as Record<string, unknown>;
    if (!isNonEmptyString(groupObj.category) || !Array.isArray(groupObj.products)) {
      throw new Error('Invalid category group in candidates file: expected category and products');
    }
    for (const product of groupObj.products) {
      register(product, groupObj.category);
    }
  }

  return byName;
}

function parseManifest(raw: unknown): ManifestBatch[] {
  if (!Array.isArray(raw)) {
    throw new Error('Invalid manifest file: expected a JSON array of batches');
  }
  return raw.map((entry, batchIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid manifest batch at index ${batchIndex}`);
    }
    const batch = entry as Record<string, unknown>;
    if (!isNonEmptyString(batch.batch) || !Array.isArray(batch.cells)) {
      throw new Error(`Invalid manifest batch at index ${batchIndex}: missing batch or cells`);
    }
    if (batch.kind !== undefined && batch.kind !== 'universal' && batch.kind !== 'text') {
      throw new Error(`Invalid manifest batch "${batch.batch}": unexpected kind`);
    }
    for (const cellEntry of batch.cells) {
      if (!cellEntry || typeof cellEntry !== 'object' || Array.isArray(cellEntry)) {
        throw new Error(`Invalid cell in batch "${batch.batch}"`);
      }
      const cell = cellEntry as Record<string, unknown>;
      if (
        typeof cell.cell !== 'number' ||
        !Number.isInteger(cell.cell) ||
        cell.cell < 1 ||
        !isNonEmptyString(cell.category) ||
        !isNonEmptyString(cell.name) ||
        !isNonEmptyString(cell.nameEn)
      ) {
        throw new Error(`Invalid cell metadata in batch "${batch.batch}"`);
      }
      if (cell.text !== undefined && typeof cell.text !== 'boolean') {
        throw new Error(`Invalid "text" flag on ${batch.batch}#${cell.cell}`);
      }
      if (cell.supersededBy !== undefined && !isNonEmptyString(cell.supersededBy)) {
        throw new Error(`Invalid "supersededBy" value on ${batch.batch}#${cell.cell}`);
      }
    }
    return {
      batch: batch.batch,
      kind: batch.kind as BatchKind | undefined,
      file: typeof batch.file === 'string' ? batch.file : '',
      fileEn: typeof batch.fileEn === 'string' ? batch.fileEn : undefined,
      cells: batch.cells as ManifestBatch['cells'],
    };
  });
}

// Selects the legacy batch-NNN cells marked as superseded by a text batch
// and cross-checks them against both manifest text batches and candidates.json.
export function loadLegacyRussianTargets(paths?: {
  manifestPath?: string;
  candidatesPath?: string;
}): LegacyRussianTarget[] {
  const manifestPath = resolve(paths?.manifestPath ?? DEFAULT_MANIFEST_PATH);
  const candidatesPath = resolve(paths?.candidatesPath ?? DEFAULT_CANDIDATES_PATH);

  const batches = parseManifest(readJsonFile(manifestPath, 'manifest'));
  const candidatesByName = parseCandidates(readJsonFile(candidatesPath, 'candidates'));

  const textCells = new Map<string, { name: string; nameEn: string; category: string }>();
  for (const batch of batches) {
    if (batch.kind !== 'text') continue;
    if (!TEXT_BATCH_RE.test(batch.batch)) {
      throw new Error(`Invalid text batch identifier "${batch.batch}" in manifest`);
    }
    for (const cell of batch.cells) {
      const ref = cellRef(batch.batch, cell.cell);
      if (textCells.has(ref)) {
        throw new Error(`Duplicate text cell reference "${ref}" in manifest`);
      }
      textCells.set(ref, { name: cell.name, nameEn: cell.nameEn, category: cell.category });
    }
  }

  const targets: LegacyRussianTarget[] = [];
  const seenRefs = new Set<string>();

  for (const batch of batches) {
    if (batch.kind === 'text') continue;
    if (!UNIVERSAL_BATCH_RE.test(batch.batch)) continue;

    for (const cell of batch.cells) {
      const ref = cellRef(batch.batch, cell.cell);
      const candidate = candidatesByName.get(normalizeCatalogName(cell.name));

      if (!cell.supersededBy) {
        if (cell.text || candidate?.text) {
          throw new Error(
            `Manifest mismatch on ${ref} ("${cell.name}"): marked as text without supersededBy`
          );
        }
        continue;
      }

      if (!TEXT_CELL_REF_RE.test(cell.supersededBy)) {
        throw new Error(
          `Invalid supersededBy "${cell.supersededBy}" on ${ref}; expected "text-NNN#C"`
        );
      }
      if (!cell.text) {
        throw new Error(
          `Manifest mismatch on ${ref} ("${cell.name}"): supersededBy is set without text=true`
        );
      }
      if (!candidate || !candidate.text) {
        throw new Error(
          `Candidates mismatch on ${ref} ("${cell.name}"): missing text=true candidate`
        );
      }
      if (
        normalizeCatalogName(candidate.nameEn) !== normalizeCatalogName(cell.nameEn) ||
        normalizeCatalogName(candidate.category) !== normalizeCatalogName(cell.category)
      ) {
        throw new Error(
          `Candidates mismatch on ${ref} ("${cell.name}"): nameEn or category differs from manifest`
        );
      }

      const textTarget = textCells.get(cell.supersededBy);
      if (!textTarget) {
        throw new Error(`Missing supersededBy target "${cell.supersededBy}" referenced by ${ref}`);
      }
      if (
        normalizeCatalogName(textTarget.name) !== normalizeCatalogName(cell.name) ||
        normalizeCatalogName(textTarget.nameEn) !== normalizeCatalogName(cell.nameEn) ||
        normalizeCatalogName(textTarget.category) !== normalizeCatalogName(cell.category)
      ) {
        throw new Error(
          `SupersededBy target "${cell.supersededBy}" does not match ${ref} ("${cell.name}")`
        );
      }
      if (seenRefs.has(ref)) {
        throw new Error(`Duplicate legacy target reference "${ref}" in manifest`);
      }
      seenRefs.add(ref);
      targets.push({
        ref,
        batch: batch.batch,
        cell: cell.cell,
        name: cell.name,
        nameEn: cell.nameEn,
        category: cell.category,
        supersededBy: cell.supersededBy,
      });
    }
  }

  if (targets.length === 0) {
    throw new Error('No superseded batch-NNN cells found in manifest and candidates');
  }

  return targets;
}

// Loads the built-in repository manifest and candidates and enforces the exact
// approved target count so override files and apply paths cannot drift in scope.
export function loadCanonicalLegacyRussianTargets(paths?: {
  manifestPath?: string;
  candidatesPath?: string;
}): LegacyRussianTarget[] {
  const manifestPath = paths?.manifestPath ?? resolve(REPO_ROOT, DEFAULT_MANIFEST_PATH);
  const candidatesPath = paths?.candidatesPath ?? resolve(REPO_ROOT, DEFAULT_CANDIDATES_PATH);
  const targets = loadLegacyRussianTargets({ manifestPath, candidatesPath });

  if (targets.length !== EXPECTED_LEGACY_TARGET_COUNT) {
    throw new Error(
      `Canonical repository manifest/candidates must define exactly ${EXPECTED_LEGACY_TARGET_COUNT} legacy Russian targets (found ${targets.length})`
    );
  }

  return targets;
}

// Verifies that the supplied targets match the exact set of canonical sourceRefs
// derived from the built-in repository manifest and candidates.
export function assertApprovedLegacyRussianTargets(
  targets: readonly LegacyRussianTarget[],
  canonicalTargets: readonly LegacyRussianTarget[] = loadCanonicalLegacyRussianTargets()
): void {
  const canonicalRefs = new Set(canonicalTargets.map((target) => target.ref));
  if (
    canonicalTargets.length !== EXPECTED_LEGACY_TARGET_COUNT ||
    canonicalRefs.size !== EXPECTED_LEGACY_TARGET_COUNT
  ) {
    throw new Error(
      `Canonical target set must contain exactly ${EXPECTED_LEGACY_TARGET_COUNT} unique sourceRef(s)`
    );
  }

  const targetRefs = new Set<string>();
  for (const target of targets) {
    if (targetRefs.has(target.ref)) {
      throw new Error('Duplicate target cell references');
    }
    targetRefs.add(target.ref);
  }

  const missingRefs = [...canonicalRefs].filter((ref) => !targetRefs.has(ref));
  const unexpectedRefs = [...targetRefs].filter((ref) => !canonicalRefs.has(ref));

  if (
    targets.length !== EXPECTED_LEGACY_TARGET_COUNT ||
    missingRefs.length > 0 ||
    unexpectedRefs.length > 0
  ) {
    const details: string[] = [];
    if (missingRefs.length > 0) details.push(`missing: ${missingRefs.join(', ')}`);
    if (unexpectedRefs.length > 0) details.push(`unexpected: ${unexpectedRefs.join(', ')}`);
    throw new Error(
      `Target scope mismatch: expected the ${EXPECTED_LEGACY_TARGET_COUNT} canonical sourceRef(s), got ${targets.length}${details.length > 0 ? ` (${details.join('; ')})` : ''}`
    );
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function planLegacyRussianLocales(
  db: LibraryDbReader,
  targets: LegacyRussianTarget[]
): Promise<LegacyRussianPlan> {
  if (targets.length === 0) {
    throw new Error('Targets list must not be empty');
  }

  assertApprovedLegacyRussianTargets(targets);

  const refs = targets.map((target) => target.ref);

  const enRefs = refs.map((ref) => `${ref}:en`);
  const [totalLibraryCount, refRows] = await Promise.all([
    db.emojiLibraryItem.count(),
    db.emojiLibraryItem.findMany({
      where: { sourceRef: { in: [...refs, ...enRefs] } },
      select: LIBRARY_SELECT,
    }),
  ]);

  const byId = new Map<string, LibraryRow>();
  const bySourceRef = new Map<string, LibraryRow>();
  for (const row of refRows) {
    byId.set(row.id, row);
    if (row.sourceRef) bySourceRef.set(row.sourceRef, row);
  }

  const missingRefs = refs.filter((ref) => !bySourceRef.has(ref));
  if (missingRefs.length > 0) {
    throw new Error(`Missing library item(s) for sourceRef: ${missingRefs.join(', ')}`);
  }

  const candidateGroupKeys = [
    ...new Set([
      ...refs,
      ...refRows
        .map((row) => nonEmpty(row.groupKey))
        .filter((value): value is string => value !== null),
    ]),
  ];

  const groupRows =
    candidateGroupKeys.length > 0
      ? await db.emojiLibraryItem.findMany({
          where: { groupKey: { in: candidateGroupKeys } },
          select: LIBRARY_SELECT,
        })
      : [];

  for (const row of groupRows) {
    byId.set(row.id, row);
    if (row.sourceRef) bySourceRef.set(row.sourceRef, row);
  }

  const byGroupKey = new Map<string, LibraryRow[]>();
  for (const row of byId.values()) {
    const key = nonEmpty(row.groupKey);
    if (!key) continue;
    const list = byGroupKey.get(key) ?? [];
    list.push(row);
    byGroupKey.set(key, list);
  }

  const claimedGroupKeys = new Map<string, string>();
  const claimedEnIds = new Map<string, string>();
  const items: PlannedLegacyRussianItem[] = [];
  const operations: LibraryUpdateOp[] = [];

  for (const target of targets) {
    const ruRow = bySourceRef.get(target.ref)!;
    if (ruRow.locale !== null && ruRow.locale !== 'ru') {
      throw new Error(
        `Unexpected locale "${ruRow.locale}" for ${target.ref} (${ruRow.id}); expected null or "ru"`
      );
    }

    const enRef = `${target.ref}:en`;
    const refTwin = bySourceRef.get(enRef) ?? null;
    if (refTwin) {
      if (refTwin.id === ruRow.id) {
        throw new Error(
          `Invalid library state: ${enRef} resolves to the same row as ${target.ref}`
        );
      }
      if (refTwin.locale !== 'en') {
        throw new Error(
          `Unexpected locale "${refTwin.locale}" for English twin ${enRef} (${refTwin.id}); expected "en"`
        );
      }
    }

    const ruGroupKey = nonEmpty(ruRow.groupKey);
    const groupSiblings = ruGroupKey
      ? (byGroupKey.get(ruGroupKey) ?? []).filter((row) => row.id !== ruRow.id)
      : [];

    const nonEnglishSibling = groupSiblings.find((row) => row.locale !== 'en');
    if (nonEnglishSibling) {
      throw new Error(
        `Unexpected non-English sibling (${nonEnglishSibling.id}, locale=${nonEnglishSibling.locale}) sharing groupKey "${ruGroupKey}" with ${target.ref}`
      );
    }
    if (groupSiblings.length > 1) {
      throw new Error(
        `Ambiguous English versions (${groupSiblings.length}) sharing groupKey "${ruGroupKey}" for ${target.ref}`
      );
    }

    const groupTwin = groupSiblings[0] ?? null;
    if (refTwin && groupTwin && refTwin.id !== groupTwin.id) {
      throw new Error(
        `Ambiguous English versions for ${target.ref}: ${enRef} (${refTwin.id}) conflicts with groupKey "${ruGroupKey}" sibling (${groupTwin.id})`
      );
    }

    const enRow = refTwin ?? groupTwin;
    if (!enRow) {
      const ruData: LibraryUpdateOp['data'] = {};
      if (ruRow.locale !== 'ru') ruData.locale = 'ru';
      const changed = Object.keys(ruData).length > 0;
      if (changed) {
        operations.push({ id: ruRow.id, sourceRef: ruRow.sourceRef, data: ruData });
      }
      items.push({
        ref: target.ref,
        name: target.name,
        supersededBy: target.supersededBy,
        paired: false,
        enId: null,
        enSourceRef: null,
        ruLocaleFrom: ruRow.locale,
        ruLocaleTo: 'ru',
        ruGroupKeyFrom: ruRow.groupKey,
        ruGroupKeyTo: ruRow.groupKey,
        enGroupKeyFrom: null,
        enGroupKeyTo: null,
        targetGroupKey: ruRow.groupKey,
        changed,
      });
      continue;
    }

    const priorTarget = claimedEnIds.get(enRow.id);
    if (priorTarget) {
      throw new Error(
        `English library item ${enRow.id} matched multiple legacy targets (${priorTarget} and ${target.ref})`
      );
    }
    claimedEnIds.set(enRow.id, target.ref);

    // Share the English version's groupKey when present; if missing, keep an existing Russian
    // groupKey or fall back to the repository cell-reference convention ("batch-NNN#C").
    const targetGroupKey = nonEmpty(enRow.groupKey) ?? ruGroupKey ?? target.ref;

    const priorGroupOwner = claimedGroupKeys.get(targetGroupKey);
    if (priorGroupOwner) {
      throw new Error(
        `Group key "${targetGroupKey}" collides across legacy targets (${priorGroupOwner} and ${target.ref})`
      );
    }
    claimedGroupKeys.set(targetGroupKey, target.ref);

    const conflictingRow = (byGroupKey.get(targetGroupKey) ?? []).find(
      (row) => row.id !== ruRow.id && row.id !== enRow.id
    );
    if (conflictingRow) {
      throw new Error(
        `Group key "${targetGroupKey}" for ${target.ref} is already used by another library item (${conflictingRow.id})`
      );
    }

    const ruData: LibraryUpdateOp['data'] = {};
    if (ruRow.locale !== 'ru') ruData.locale = 'ru';
    if (ruRow.groupKey !== targetGroupKey) ruData.groupKey = targetGroupKey;
    if (Object.keys(ruData).length > 0) {
      operations.push({ id: ruRow.id, sourceRef: ruRow.sourceRef, data: ruData });
    }

    const enData: LibraryUpdateOp['data'] = {};
    if (enRow.groupKey !== targetGroupKey) enData.groupKey = targetGroupKey;
    if (Object.keys(enData).length > 0) {
      operations.push({ id: enRow.id, sourceRef: enRow.sourceRef, data: enData });
    }

    items.push({
      ref: target.ref,
      name: target.name,
      supersededBy: target.supersededBy,
      paired: true,
      enId: enRow.id,
      enSourceRef: enRow.sourceRef,
      ruLocaleFrom: ruRow.locale,
      ruLocaleTo: 'ru',
      ruGroupKeyFrom: ruRow.groupKey,
      ruGroupKeyTo: targetGroupKey,
      enGroupKeyFrom: enRow.groupKey,
      enGroupKeyTo: targetGroupKey,
      targetGroupKey,
      changed: Object.keys(ruData).length > 0 || Object.keys(enData).length > 0,
    });
  }

  return {
    totalLibraryCount,
    items,
    operations,
  };
}

export async function applyLegacyRussianLocalesInTx(
  tx: LibraryTxClient,
  targets: LegacyRussianTarget[]
): Promise<LegacyRussianApplyResult> {
  assertApprovedLegacyRussianTargets(targets);
  const plan = await planLegacyRussianLocales(tx, targets);
  for (const op of plan.operations) {
    await tx.emojiLibraryItem.update({
      where: { id: op.id },
      data: op.data,
    });
  }
  const totalLibraryCountAfter = await tx.emojiLibraryItem.count();
  if (totalLibraryCountAfter !== plan.totalLibraryCount) {
    throw new Error(
      `Library row count changed unexpectedly (${plan.totalLibraryCount} -> ${totalLibraryCountAfter})`
    );
  }
  return {
    plan,
    totalLibraryCountAfter,
    appliedUpdates: plan.operations.length,
  };
}

export async function applyLegacyRussianLocales(
  prisma: Pick<PrismaClient, '$transaction'>,
  targets: LegacyRussianTarget[]
): Promise<LegacyRussianApplyResult> {
  assertApprovedLegacyRussianTargets(targets);
  return prisma.$transaction((tx) => applyLegacyRussianLocalesInTx(tx, targets), {
    isolationLevel: 'Serializable',
    timeout: 30_000,
  });
}

export function parseCliArgs(argv: string[]): CliOptions {
  let apply = false;
  let help = false;
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let candidatesPath = DEFAULT_CANDIDATES_PATH;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--manifest' || arg === '--candidates') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Option ${arg} requires a file path`);
      }
      if (arg === '--manifest') manifestPath = value;
      else candidatesPath = value;
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { apply, help, manifestPath, candidatesPath };
}

export function sanitizeDatabaseErrorMessage(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]');
}
