// One verified backup run: dump -> restore and compare -> encrypt -> publish -> prune.
// Plaintext and the temporary PostgreSQL cluster live only in a private temp directory,
// removed on success, failure and interruption. Old copies are pruned only after a new
// copy is complete, and only the retention policy decides what is removed.
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_NAME_PATTERN,
  BACKUP_PREFIX,
  BACKUP_SUFFIX,
  DROP_THRESHOLD_PERCENT,
  EXIT,
  META_DIR,
  MESSAGES,
  TEMP_PREFIX,
} from './constants.mjs';
import {
  compareIdentities,
  findDrops,
  parseCounts,
  parseIdentities,
  parseMigration,
} from './compare.mjs';
import { acquireLock } from './lock.mjs';
import { selectRetention } from './retention.mjs';
import { appendStatus, formatStatusLine } from './status.mjs';
import {
  buildImageArgs,
  cleanupArgs,
  dumpArgs,
  encryptArgs,
  inspectImageArgs,
  Interrupted,
  verifyArgs,
  versionArgs,
} from './docker.mjs';

const STALE_TEMP_MS = 60 * 60 * 1000;

export class StepError extends Error {
  constructor(key, exit) {
    super(key);
    this.key = key;
    this.exit = exit;
  }
}

// 20261124T120000Z: sorts chronologically and is safe in file names.
export function stamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

const containerName = (step) => `clickmoji-backup-${step}-${crypto.randomBytes(6).toString('hex')}`;

function isNonEmptyFile(file) {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fsyncFile(file) {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Temp directories left behind by a run that was SIGKILLed. Only old ones are removed,
// so a run in another backup directory that is still working is not disturbed.
function sweepStaleTemp(tempRoot, nowMs) {
  for (const entry of readdirSync(tempRoot)) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(tempRoot, entry);
    try {
      if (nowMs - statSync(full).mtimeMs > STALE_TEMP_MS)
        rmSync(full, { recursive: true, force: true });
    } catch {
      // Not ours to fix; the run does not depend on it.
    }
  }
}

// Completed copies in the backup directory, by the time in their file name.
export function listBackups(backupDir) {
  return readdirSync(backupDir)
    .map((name) => ({ name, match: BACKUP_NAME_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .map((entry) => {
      const raw = entry.match[1];
      const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
      return { name: entry.name, time: new Date(iso) };
    });
}

// Row counts of the newest copy that passed or was flagged in verification, if any.
function readPreviousCounts(backupDir) {
  const metaDir = path.join(backupDir, META_DIR);
  if (!existsSync(metaDir)) return null;
  const names = readdirSync(metaDir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.partial-'))
    .sort()
    .reverse();
  for (const name of names) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(path.join(metaDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (meta.verify === 'ok' || meta.verify === 'suspicious')
      return new Map(Object.entries(meta.counts));
  }
  return null;
}

// Copy into the backup directory under a partial name, then rename. A reader never sees
// a partial copy, and a failure leaves no partial files behind.
function publish({ backupDir, encryptedFile, name, meta }) {
  const metaDir = path.join(backupDir, META_DIR);
  mkdirSync(metaDir, { recursive: true, mode: 0o700 });
  const partialDump = path.join(backupDir, `.partial-${name}`);
  const partialMeta = path.join(metaDir, `.partial-${name}.json`);
  const finalDump = path.join(backupDir, name);
  const finalMeta = path.join(metaDir, `${name}.json`);
  let dumpMoved = false;
  try {
    if (existsSync(finalDump)) throw new Error('name taken');
    copyFileSync(encryptedFile, partialDump);
    fsyncFile(partialDump);
    writeFileSync(partialMeta, JSON.stringify(meta), { mode: 0o600 });
    renameSync(partialDump, finalDump);
    dumpMoved = true;
    renameSync(partialMeta, finalMeta);
  } catch {
    rmSync(partialDump, { force: true });
    rmSync(partialMeta, { force: true });
    if (dumpMoved) rmSync(finalDump, { force: true });
    throw new StepError('publish', EXIT.failed);
  }
}

// Throws StepError for a failed step, or Interrupted when the run is aborted.
async function executeBackup({ config, docker, now, tempDir }) {
  const run = async (args, key, exit = EXIT.failed) => {
    const result = await docker.run(args);
    if (result.code !== 0) throw new StepError(key, exit);
  };

  await run(versionArgs(), 'docker', EXIT.unavailable);

  if ((await docker.run(inspectImageArgs())).code !== 0) {
    await run(buildImageArgs(), 'image', EXIT.unavailable);
  }

  const startedAt = now();
  const dumpFile = path.join(tempDir, 'dump.custom');
  await run(dumpArgs({ name: containerName('dump'), workDir: tempDir }), 'dump');
  if (!isNonEmptyFile(dumpFile)) throw new StepError('dump', EXIT.failed);

  const reportDir = path.join(tempDir, 'out');
  mkdirSync(reportDir);
  await run(verifyArgs({ name: containerName('verify'), workDir: tempDir }), 'verify');

  let sourceIdentities;
  let sourceMigration;
  let identities;
  let migration;
  let counts;
  try {
    const sourceDir = path.join(reportDir, 'source');
    const restoredDir = path.join(reportDir, 'restored');
    sourceIdentities = parseIdentities(
      readFileSync(path.join(sourceDir, 'identities.tsv'), 'utf8')
    );
    sourceMigration = parseMigration(readFileSync(path.join(sourceDir, 'migration.txt'), 'utf8'));
    identities = parseIdentities(readFileSync(path.join(restoredDir, 'identities.tsv'), 'utf8'));
    migration = parseMigration(readFileSync(path.join(restoredDir, 'migration.txt'), 'utf8'));
    counts = parseCounts(readFileSync(path.join(restoredDir, 'counts.tsv'), 'utf8'));
  } catch {
    throw new StepError('verify', EXIT.failed);
  }
  if (compareIdentities(sourceIdentities, identities).length > 0)
    throw new StepError('verify', EXIT.failed);
  if (sourceMigration !== migration) throw new StepError('verify', EXIT.failed);
  for (const table of identities.keys()) {
    if (!counts.has(table)) throw new StepError('verify', EXIT.failed);
  }

  const previous = readPreviousCounts(config.backupDir);
  const drops = previous ? findDrops(previous, counts, DROP_THRESHOLD_PERCENT) : [];
  const verify = drops.length > 0 ? 'suspicious' : 'ok';

  const encryptedFile = path.join(tempDir, 'dump.age');
  await run(
    encryptArgs({
      name: containerName('encrypt'),
      workDir: tempDir,
      recipientFile: config.recipientFile,
    }),
    'encrypt'
  );
  if (!isNonEmptyFile(encryptedFile)) throw new StepError('encrypt', EXIT.failed);

  const name = `${BACKUP_PREFIX}${stamp(startedAt)}${BACKUP_SUFFIX}`;
  const meta = {
    name,
    createdAt: startedAt.toISOString(),
    sizeBytes: statSync(encryptedFile).size,
    sha256: sha256(encryptedFile),
    verify,
    migration,
    counts: Object.fromEntries(counts),
    flagged: drops.map((drop) => drop.table),
  };
  publish({ backupDir: config.backupDir, encryptedFile, name, meta });

  // Pruning runs only after the new copy is in place.
  let pruned = 'ok';
  try {
    const { remove } = selectRetention(listBackups(config.backupDir));
    for (const old of remove) {
      rmSync(path.join(config.backupDir, old), { force: true });
      rmSync(path.join(config.backupDir, META_DIR, `${old}.json`), { force: true });
    }
  } catch {
    pruned = 'incomplete';
  }
  return { name, sizeBytes: meta.sizeBytes, verify, pruned };
}

// Returns true when the directory is gone. Container-written files may belong to another
// uid, so a failed plain removal is retried from inside the tools image.
async function removeTemp(tempDir, docker) {
  rmSync(tempDir, { recursive: true, force: true });
  if (!existsSync(tempDir)) return true;
  await docker.exec(cleanupArgs({ name: containerName('cleanup'), workDir: tempDir }));
  rmSync(tempDir, { recursive: true, force: true });
  return !existsSync(tempDir);
}

function classify(error) {
  if (error instanceof StepError) return { ok: false, key: error.key, exit: error.exit };
  if (error instanceof Interrupted)
    return { ok: false, key: 'interrupted', exit: EXIT.interrupted };
  return { ok: false, key: 'internal', exit: EXIT.failed };
}

function report(config, now, result) {
  const when = now();
  const line = result.ok
    ? formatStatusLine({
        now: when,
        outcome: result.verify === 'suspicious' ? 'suspicious' : 'ok',
        detail: `size=${result.sizeBytes} verify=${result.verify} file=${result.name} prune=${result.pruned}`,
      })
    : formatStatusLine({ now: when, outcome: 'failed', detail: MESSAGES[result.key] });
  appendStatus(config.statusFile, line);
  return {
    ...result,
    exit: result.ok ? (result.verify === 'suspicious' ? EXIT.suspicious : EXIT.ok) : result.exit,
  };
}

// Never throws for an expected failure: the outcome is written to the status file and returned.
export async function runBackup({
  config,
  docker,
  now = () => new Date(),
  tempRoot = os.tmpdir(),
}) {
  mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(config.backupDir);
  if (!lock) return report(config, now, { ok: false, key: 'busy', exit: EXIT.busy });

  let result;
  let tempDir = null;
  try {
    sweepStaleTemp(tempRoot, now().getTime());
    tempDir = mkdtempSync(path.join(tempRoot, TEMP_PREFIX));
    result = { ok: true, ...(await executeBackup({ config, docker, now, tempDir })) };
  } catch (error) {
    result = classify(error);
  } finally {
    if (tempDir && !(await removeTemp(tempDir, docker))) {
      // Plaintext left on disk is reported even when the copy itself succeeded.
      result = { ok: false, key: 'cleanup', exit: EXIT.failed };
    }
    lock.release();
  }
  return report(config, now, result);
}
