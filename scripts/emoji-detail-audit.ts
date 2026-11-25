import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_CATALOG_EXPORT_PATH,
  DEFAULT_DETAIL_THRESHOLD_BYTES,
  DEFAULT_STYLE_REFS_DIR,
  assertPathOutsideRepo,
  auditCatalogImages,
  createCachingImageLoader,
  expandHomePath,
  formatCatalogAuditMarkdown,
  loadStyleRefs,
  parseCatalogExport,
  parseDetailThreshold,
  type CatalogAuditScope,
} from '../src/lib/services/emoji-detail';

// Measures the canonical detail score on public images from a catalogue export JSON without any
// database connection. Downloaded images are cached only in a temporary directory outside the repo.
//
// Usage:
//   npx tsx scripts/emoji-detail-audit.ts [options]
//
// Options:
//   --input <file.json>        Catalogue export JSON (default: ~/.local/share/dev-harness/artifacts/clickmoji/catalog-export-2026-11-25.json)
//   --cache-dir <dir>          Cache directory outside repo (default: new temp dir under os.tmpdir())
//   --out <dir>                Write detail-report.json and detail-report.md outside repo
//   --detail-threshold <bytes> Strict threshold in WebP bytes (default: 14000)
//   --scope <products|all>     "products" = 227 product.imageUrl (default); "all" = all 269 slots
//   --style-refs <dir>         Style reference folder (default: docs/emoji-batches/style-refs)
//   --offline                  Do not fetch over HTTP; missing cached copies are reported UNKNOWN
//   --timeout-ms <ms>          Per-image HTTP timeout in ms (default: 15000)
//   --concurrency <n>          Parallel workers (default: 8)
//   -h, --help                 Show this help message

const USAGE = [
  'Usage: npx tsx scripts/emoji-detail-audit.ts [options]',
  '',
  'Measure canonical WebP detail score on a read-only catalogue export JSON (no database).',
  '',
  'Options:',
  `  --input <file.json>        Catalogue export JSON (default: ${DEFAULT_CATALOG_EXPORT_PATH})`,
  '  --cache-dir <dir>          Temp cache directory outside the repo (default: $TMPDIR/clickmoji-detail-cache)',
  '  --out <dir>                Output directory outside the repo for detail-report.json & .md',
  `  --detail-threshold <bytes> Strict outlier threshold in bytes (default: ${DEFAULT_DETAIL_THRESHOLD_BYTES})`,
  '  --scope <products|all>     "products" (default: 227 primary product images) or "all" (all slots)',
  `  --style-refs <dir>         Style reference images folder (default: ${DEFAULT_STYLE_REFS_DIR})`,
  '  --offline                  Use only local copies in --cache-dir; missing files become UNKNOWN',
  '  --timeout-ms <ms>          Fetch timeout per image in milliseconds (default: 15000)',
  '  --concurrency <n>          Number of parallel workers (default: 8)',
  '  -h, --help                 Show this help message',
].join('\n');

function requiredFlagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Flag ${name} requires a value`);
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid ${label} "${raw}": expected positive integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label} "${raw}": expected positive integer`);
  }
  return value;
}

function parseScope(raw: string | undefined): CatalogAuditScope {
  if (raw === undefined || raw === 'products') return 'products';
  if (raw === 'all') return 'all';
  throw new Error(`Invalid --scope "${raw}": expected "products" or "all"`);
}

export async function runAuditCli(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const inputPath = resolve(
    expandHomePath(requiredFlagValue(argv, '--input') ?? DEFAULT_CATALOG_EXPORT_PATH)
  );
  const cacheDir = resolve(
    expandHomePath(
      requiredFlagValue(argv, '--cache-dir') ?? join(tmpdir(), 'clickmoji-detail-cache')
    )
  );
  const outArg = requiredFlagValue(argv, '--out');
  const outDir = outArg ? resolve(expandHomePath(outArg)) : undefined;
  const threshold = parseDetailThreshold(requiredFlagValue(argv, '--detail-threshold'));
  const scope = parseScope(requiredFlagValue(argv, '--scope'));
  const styleRefsDir = requiredFlagValue(argv, '--style-refs') ?? DEFAULT_STYLE_REFS_DIR;
  const offline = argv.includes('--offline');
  const timeoutMs = parsePositiveInt(
    requiredFlagValue(argv, '--timeout-ms'),
    15_000,
    '--timeout-ms'
  );
  const concurrency = parsePositiveInt(
    requiredFlagValue(argv, '--concurrency'),
    8,
    '--concurrency'
  );

  assertPathOutsideRepo(cacheDir);
  if (outDir) assertPathOutsideRepo(outDir);

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read catalogue export "${inputPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const { entries, counts } = parseCatalogExport(rawJson, scope);
  const styleRefs = await loadStyleRefs(styleRefsDir);
  const loadImage = createCachingImageLoader({ cacheDir, offline, timeoutMs });

  const report = await auditCatalogImages({
    entries,
    counts,
    scope,
    threshold,
    styleRefs,
    loadImage,
    concurrency,
  });

  const markdown = formatCatalogAuditMarkdown(report);
  console.log(markdown);

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const jsonPath = join(outDir, 'detail-report.json');
    const mdPath = join(outDir, 'detail-report.md');
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(mdPath, `${markdown}\n`);
    console.log(`Report files: ${jsonPath} | ${mdPath}`);
  }
  console.log(`Cache directory (outside repo): ${cacheDir}`);
  console.log(
    `Summary: scope=${report.scope}, selected=${report.selectedTotal}, measured=${report.measuredCount}, unknown=${report.unknownCount}, outliers=${report.outlierCount}, threshold=>${report.threshold}B`
  );

  return report.complete ? 0 : 1;
}

if (process.argv[1]?.endsWith('emoji-detail-audit.ts')) {
  runAuditCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
