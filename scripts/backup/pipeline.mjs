// One verified backup run: dump -> restore and compare -> [encrypt] -> git check -> publish -> prune.
// Plaintext and the temporary PostgreSQL cluster live only in a private temp directory outside any
// repository, removed on success, failure and interruption. When encryption is off (default), the
// verified custom-format dump is stored in backupDir as an explicit operator exception; when
// encryption is enabled, only ciphertext enters backupDir, and after the first published encrypted
// copy all prior recognized unencrypted copies are removed before pruning.
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_ENCRYPTED_SUFFIX,
  BACKUP_NAME_PATTERN,
  BACKUP_PLAIN_SUFFIX,
  BACKUP_PREFIX,
  BUILD_TIMEOUT_MS,
  DROP_THRESHOLD_PERCENT,
  EXIT,
  META_DIR,
  MESSAGES,
  TEMP_MARKER,
  TEMP_PREFIX,
} from './constants.mjs';
import {
  compareIdentities,
  findDrops,
  parseCounts,
  parseIdentities,
  parseMigration,
} from './compare.mjs';
import { checkStatusTarget, REPO_ROOT } from './config.mjs';
import {
  canonicalPath,
  isInsidePath,
  isTempRootUnsafeForGit,
  verifyBackupDirGitIgnored,
} from './git.mjs';
import { pidAlive } from './lock.mjs';
import { Ledger, LedgerError } from './ledger.mjs';
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

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

// Creates destFile with mode 0600 from its very creation (even under a permissive umask)
// and copies sourceFile without exposing a world-readable intermediate file.
export function writePrivateCopy(sourceFile, destFile) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const srcFd = openSync(sourceFile, 'r');
  let destFd = null;
  try {
    destFd = openSync(destFile, flags, 0o600);
    if ((fstatSync(destFd).mode & 0o777) !== 0o600) {
      throw new Error('destination file permissions are not 0600');
    }
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(srcFd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        offset += writeSync(destFd, buf, offset, bytesRead - offset);
      }
    }
    fsyncSync(destFd);
  } finally {
    if (destFd !== null) closeSync(destFd);
    closeSync(srcFd);
  }
}

function writePrivateText(destFile, text) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(destFile, flags, 0o600);
  try {
    if ((fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error('metadata file permissions are not 0600');
    }
    const data = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const backupKey = (backupDir) => crypto.createHash('sha256').update(backupDir).digest('hex');

// The host's own removal. Injected only by tests (see removeTemp), which need a deterministic refusal.
const hostRemove = (target) => rmSync(target, { recursive: true, force: true });

function removeQuietly(target, remove = hostRemove) {
  try {
    remove(target);
  } catch {
    // Left in place; the caller checks whether the directory is gone.
  }
}

// Recovers temporary directories that an earlier run of THIS backup directory left behind
// (for example after SIGKILL). A directory is recovered only when its marker names this backup
// directory and a process that no longer exists. The caller holds this directory's lock, so
// no live run of it can exist. Other backup directories, unmarked entries and entries of
// live processes are never touched, whatever their age.
// Each recovered directory goes through removeTemp, the same path a run uses. One that stays
// is a failure: the run stops before any dump, publish or prune.
async function sweepStaleTemp(tempRoot, backupDir, docker) {
  let entries;
  try {
    entries = readdirSync(tempRoot);
  } catch {
    throw new StepError('cleanup', EXIT.failed);
  }
  const key = backupKey(backupDir);
  const stale = [];
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(tempRoot, entry);
    let marker;
    try {
      marker = JSON.parse(readFileSync(path.join(full, TEMP_MARKER), 'utf8'));
    } catch {
      continue;
    }
    if (marker?.backupKey !== key || !Number.isInteger(marker.pid)) continue;
    if (pidAlive(marker.pid)) continue;
    stale.push(full);
  }
  let stuck = false;
  for (const dir of stale) {
    let gone = false;
    try {
      gone = await removeTemp(dir, docker);
    } catch {
      gone = false;
    }
    if (!gone) stuck = true;
  }
  if (stuck) throw new StepError('cleanup', EXIT.failed);
}

// Completed, accepted copies in the backup directory, by the time in their file name.
// Recognizes both unencrypted (.dump) and encrypted (.dump.age) copies and uses a single
// publication completeness model across baseline comparison, transition purge, and retention:
// a dump file is accepted only when its committed metadata record exists with verify === 'ok'
// and valid counts (compatible with prior-version records that omit the `encrypted` field).
function inspectCompletedBackup(backupDir, name, match) {
  const dumpPath = path.join(backupDir, name);
  let dumpLstat;
  try {
    dumpLstat = lstatSync(dumpPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'incomplete' };
    throw new StepError('verify', EXIT.failed);
  }
  if (dumpLstat.isSymbolicLink() || !dumpLstat.isFile()) {
    throw new StepError('verify', EXIT.failed);
  }
  if (dumpLstat.size <= 0) {
    return { status: 'incomplete' };
  }

  const metaPath = path.join(backupDir, META_DIR, `${name}.json`);
  let metaLstat;
  try {
    metaLstat = lstatSync(metaPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'incomplete' };
    throw new StepError('verify', EXIT.failed);
  }
  if (metaLstat.isSymbolicLink() || !metaLstat.isFile()) {
    throw new StepError('verify', EXIT.failed);
  }

  let raw;
  try {
    raw = readFileSync(metaPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'incomplete' };
    throw new StepError('verify', EXIT.failed);
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw new StepError('verify', EXIT.failed);
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new StepError('verify', EXIT.failed);
  }
  if (meta.name !== undefined && meta.name !== name) {
    throw new StepError('verify', EXIT.failed);
  }
  const encrypted = Boolean(match[2]);
  if (meta.encrypted !== undefined && meta.encrypted !== encrypted) {
    throw new StepError('verify', EXIT.failed);
  }
  if (meta.verify === 'suspicious') {
    return { status: 'legacy-suspicious' };
  }
  if (meta.verify !== 'ok' || !isValidCounts(meta.counts)) {
    throw new StepError('verify', EXIT.failed);
  }

  const rawStamp = match[1];
  const iso = `${rawStamp.slice(0, 4)}-${rawStamp.slice(4, 6)}-${rawStamp.slice(6, 8)}T${rawStamp.slice(9, 11)}:${rawStamp.slice(11, 13)}:${rawStamp.slice(13, 15)}Z`;
  return {
    status: 'complete',
    entry: {
      name,
      time: new Date(iso),
      encrypted,
      counts: new Map(Object.entries(meta.counts)),
    },
  };
}

export function listBackups(backupDir) {
  const completed = [];
  for (const name of readdirSync(backupDir)) {
    const match = BACKUP_NAME_PATTERN.exec(name);
    if (!match) continue;
    const inspected = inspectCompletedBackup(backupDir, name, match);
    if (inspected.status === 'complete') completed.push(inspected.entry);
  }
  return completed;
}

function isValidCounts(counts) {
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) return false;
  return Object.values(counts).every((value) => Number.isInteger(value) && value >= 0);
}

// Row counts of the newest accepted copy of any age, if any.
// Unreadable or malformed metadata fails verification closed rather than ignoring the baseline.
function readPreviousCounts(backupDir) {
  const backups = listBackups(backupDir).sort(
    (a, b) => b.time - a.time || (a.name < b.name ? 1 : -1)
  );
  return backups[0]?.counts ?? null;
}

// Copy into the backup directory under a partial name (0600 from creation), then rename.
// A reader never sees a partial copy, and a failure leaves no partial files behind.
function publish({
  backupDir,
  sourceFile,
  name,
  meta,
  copyFile = writePrivateCopy,
  onBeforeMetaRename = null,
}) {
  ensurePrivateDir(backupDir);
  const metaDir = path.join(backupDir, META_DIR);
  ensurePrivateDir(metaDir);
  const partialDump = path.join(backupDir, `.partial-${name}`);
  const partialMeta = path.join(metaDir, `.partial-${name}.json`);
  const finalDump = path.join(backupDir, name);
  const finalMeta = path.join(metaDir, `${name}.json`);
  let dumpMoved = false;
  try {
    if (existsSync(finalDump) || existsSync(finalMeta)) throw new Error('name taken');
    rmSync(partialDump, { force: true });
    rmSync(partialMeta, { force: true });
    copyFile(sourceFile, partialDump);
    fsyncFile(partialDump);
    writePrivateText(partialMeta, JSON.stringify(meta));
    renameSync(partialDump, finalDump);
    dumpMoved = true;
    if (onBeforeMetaRename) onBeforeMetaRename(finalDump, partialMeta, finalMeta);
    renameSync(partialMeta, finalMeta);
  } catch {
    rmSync(partialDump, { force: true });
    rmSync(partialMeta, { force: true });
    if (dumpMoved) rmSync(finalDump, { force: true });
    throw new StepError('publish', EXIT.failed);
  }
}

function removeCopyWithMeta(backupDir, name) {
  rmSync(path.join(backupDir, name), { force: true });
  rmSync(path.join(backupDir, META_DIR, `${name}.json`), { force: true });
}

// Removes orphaned dumps lacking committed acceptance metadata (e.g. crash between the two
// renames) and leftover .partial-* files after a successful publication under the held lock.
function cleanupIncompletePublishes(backupDir) {
  for (const name of readdirSync(backupDir)) {
    if (name.startsWith('.partial-')) {
      rmSync(path.join(backupDir, name), { force: true });
      continue;
    }
    const match = BACKUP_NAME_PATTERN.exec(name);
    if (!match) continue;
    const inspected = inspectCompletedBackup(backupDir, name, match);
    if (inspected.status === 'incomplete') {
      rmSync(path.join(backupDir, name), { force: true });
    }
  }
  const metaDir = path.join(backupDir, META_DIR);
  if (existsSync(metaDir)) {
    for (const name of readdirSync(metaDir)) {
      if (name.startsWith('.partial-')) {
        rmSync(path.join(metaDir, name), { force: true });
      }
    }
  }
}

// Throws StepError for a failed step, or Interrupted when the run is aborted.
// The lock is checked again before the copy becomes visible and before anything is pruned:
// a run that no longer holds it must not touch the shared backup names.
async function executeBackup({
  config,
  docker,
  now,
  tempDir,
  lock,
  allowRowDrop = false,
  env = process.env,
  publishCopy = writePrivateCopy,
  onBeforeMetaRename = null,
  projectRoot = REPO_ROOT,
}) {
  // A container step counts only when its start exited 0 AND the daemon has been seen to hold no
  // container of its name. A zero exit alone is not proof: the daemon may be unreachable or still
  // hold it. A failure of the runner itself (a ledger that cannot be written) is a containers failure.
  const run = async (args, key, exit = EXIT.failed) => {
    let result;
    try {
      result = await docker.run(args);
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      throw new StepError('containers', EXIT.failed);
    }
    if (result.code !== 0) throw new StepError(key, exit);
    if (!result.absent) throw new StepError('containers', EXIT.failed);
  };

  // Management calls are bounded by the runner. A call that does not answer is a failure here, never
  // a result: nothing after it runs, and nothing is removed because of it.
  const manage = async (args, key, exit, options) => {
    const result = await docker.manage(args, options);
    if (result.code !== 0) throw new StepError(key, exit);
  };

  await manage(versionArgs(), 'docker', EXIT.unavailable);

  if ((await docker.manage(inspectImageArgs())).code !== 0) {
    await manage(buildImageArgs(), 'image', EXIT.unavailable, { timeoutMs: BUILD_TIMEOUT_MS });
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
  if (drops.length > 0 && !allowRowDrop) {
    throw new StepError('drop', EXIT.suspicious);
  }

  let sourceToPublish = dumpFile;
  if (config.encrypt) {
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
    sourceToPublish = encryptedFile;
  }

  const suffix = config.encrypt ? BACKUP_ENCRYPTED_SUFFIX : BACKUP_PLAIN_SUFFIX;
  const name = `${BACKUP_PREFIX}${stamp(startedAt)}${suffix}`;

  // Re-check git ignore on the exact physical temporary and final paths (including metadata) right
  // before writing to backupDir.
  const targetPaths = [
    path.join(config.backupDir, `.partial-${name}`),
    path.join(config.backupDir, name),
    path.join(config.backupDir, META_DIR, `.partial-${name}.json`),
    path.join(config.backupDir, META_DIR, `${name}.json`),
  ];
  const gitCheck = verifyBackupDirGitIgnored({
    backupDir: config.backupDir,
    gitBin: config.gitBin,
    env,
    timeoutMs: config.dockerTimeoutMs,
    projectRoot,
    targetPaths,
  });
  if (!gitCheck.ok) throw new StepError(gitCheck.key, gitCheck.exit);
  if (
    (gitCheck.repoRoot && isInsidePath(canonicalPath(config.statusFile), gitCheck.repoRoot)) ||
    (gitCheck.projectTopLevel &&
      isInsidePath(canonicalPath(config.statusFile), gitCheck.projectTopLevel))
  ) {
    throw new StepError('notIgnored', EXIT.failed);
  }

  const meta = {
    name,
    encrypted: config.encrypt,
    createdAt: startedAt.toISOString(),
    sizeBytes: statSync(sourceToPublish).size,
    sha256: sha256(sourceToPublish),
    verify: 'ok',
    migration,
    counts: Object.fromEntries(counts),
    flagged: [],
    ...(drops.length > 0 ? { confirmedRowDrops: drops.map((drop) => drop.table) } : {}),
  };
  if (!lock.held()) throw new StepError('busy', EXIT.busy);
  publish({
    backupDir: config.backupDir,
    sourceFile: sourceToPublish,
    name,
    meta,
    copyFile: publishCopy,
    onBeforeMetaRename,
  });

  // Transition & pruning run only after the new copy is completely published, and only for the lock holder.
  let pruned = 'ok';
  if (!lock.held()) {
    pruned = 'skipped';
  } else {
    try {
      cleanupIncompletePublishes(config.backupDir);
      // Enabling encryption purges all prior recognized unencrypted copies immediately after the
      // first encrypted copy is safely published, then applies normal N-copy retention.
      if (config.encrypt) {
        for (const existing of listBackups(config.backupDir)) {
          if (!existing.encrypted) removeCopyWithMeta(config.backupDir, existing.name);
        }
      }
      const { remove } = selectRetention(listBackups(config.backupDir), config.keepCount);
      for (const old of remove) {
        removeCopyWithMeta(config.backupDir, old);
      }
    } catch {
      pruned = 'incomplete';
    }
  }
  return { name, sizeBytes: meta.sizeBytes, verify: 'ok', pruned };
}

// Containers a previous run recorded and could not clear. Each is reconciled from the state the
// ledger holds for it, and must be cleared; until all are, this run does nothing else. A name that is
// still pending (its create was never seen) stays, and so does this run.
async function recoverContainers(docker, ledger) {
  let entries;
  try {
    entries = ledger.entries();
  } catch (error) {
    if (error instanceof LedgerError) throw new StepError('containers', EXIT.failed);
    throw error;
  }
  for (const { name, state } of entries) {
    if (!(await docker.reconcileRecorded(name, state)))
      throw new StepError('containers', EXIT.failed);
  }
}

// Every entry of the directory except the ownership marker.
function removeContents(tempDir, remove) {
  let entries;
  try {
    entries = readdirSync(tempDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== TEMP_MARKER) removeQuietly(path.join(tempDir, entry), remove);
  }
}

// True when anything but the marker is left, or when that cannot be told.
function contentsLeft(tempDir) {
  if (!existsSync(tempDir)) return false;
  try {
    return readdirSync(tempDir).some((entry) => entry !== TEMP_MARKER);
  } catch {
    return true;
  }
}

// Returns true only when the directory is gone. Contents go first, on the host. Container-written
// files may belong to another uid, so anything left is emptied from inside the tools image. That
// fallback is a container like any other: tracked in the ledger before it starts. Its absence must
// be proven (absent) before the host looks again; an unproven fallback stops everything here, so
// nothing is removed under a container that may still exist. The marker goes last, so a directory
// that is not fully removed keeps the marker a later sweep needs. Exported for the real-Docker test.
export async function removeTemp(tempDir, docker, remove = hostRemove) {
  removeContents(tempDir, remove);
  if (contentsLeft(tempDir)) {
    const cleanup = await docker.runAfterShutdown(
      cleanupArgs({ name: containerName('cleanup'), workDir: tempDir })
    );
    if (!cleanup.absent) return false;
    removeContents(tempDir, remove);
    if (contentsLeft(tempDir)) return false;
  }
  removeQuietly(path.join(tempDir, TEMP_MARKER), remove);
  removeQuietly(tempDir, remove);
  return !existsSync(tempDir);
}

function classify(error) {
  if (error instanceof StepError) return { ok: false, key: error.key, exit: error.exit };
  if (error instanceof Interrupted)
    return { ok: false, key: 'interrupted', exit: EXIT.interrupted };
  return { ok: false, key: 'internal', exit: EXIT.failed };
}

// `saved` is true when the copy was published, whatever happened to cleanup afterwards.
// A status line that cannot be written (the path no longer qualifies, or the write fails) is
// reported as statusWritten: false. When the copy was saved, that gets its own exit code, so the
// copy is not mistaken for a missing one.
function report(config, now, result, saved = false) {
  const when = now();
  const detailText = result.detail ?? (result.ok ? null : MESSAGES[result.key]);
  const line = result.ok
    ? formatStatusLine({
        now: when,
        outcome: 'ok',
        detail: `size=${result.sizeBytes} verify=${result.verify} file=${result.name} prune=${result.pruned}`,
      })
    : formatStatusLine({ now: when, outcome: 'failed', detail: detailText });
  // The status path is checked again: a file may have been replaced since configuration.
  let statusWritten = true;
  try {
    checkStatusTarget(config.statusFile, config.backupDir);
    appendStatus(config.statusFile, line);
  } catch {
    statusWritten = false; // nothing is written to a path that no longer qualifies
  }
  const outcomeExit = result.ok ? EXIT.ok : result.exit;
  return {
    ...result,
    saved,
    statusWritten,
    exit: !statusWritten && saved ? EXIT.statusFailed : outcomeExit,
  };
}

// The caller is the writer: it runs under the lock it was started with (see lock.mjs), passed in
// as `lock`. Without a held lock nothing is done and the run is reported busy.
// Never throws for an expected failure: the outcome is written to the status file and returned.
// The lock is held until the very end: containers, plaintext and the temporary directory are all
// dealt with before release() lets the next process in.
export async function runBackup({
  config,
  docker,
  lock,
  now = () => new Date(),
  tempRoot = os.tmpdir(),
  allowRowDrop = false,
  env = process.env,
  publishCopy = writePrivateCopy,
  onBeforeMetaRename = null,
  projectRoot = REPO_ROOT,
}) {
  // Check git ignore before creating or modifying backupDir so a non-ignored path stays untouched.
  const gitCheck = verifyBackupDirGitIgnored({
    backupDir: config.backupDir,
    gitBin: config.gitBin,
    env,
    timeoutMs: config.dockerTimeoutMs,
    projectRoot,
  });
  if (!gitCheck.ok) {
    return reportFailure(config, gitCheck.key, gitCheck.exit, now);
  }
  if (
    (gitCheck.repoRoot && isInsidePath(canonicalPath(config.statusFile), gitCheck.repoRoot)) ||
    (gitCheck.projectTopLevel &&
      isInsidePath(canonicalPath(config.statusFile), gitCheck.projectTopLevel))
  ) {
    return reportFailure(config, 'notIgnored', EXIT.failed, now);
  }

  // Ensure temporary plaintext storage is strictly outside any repository and outside backupDir.
  try {
    const resolvedTmp = canonicalPath(tempRoot);
    if (
      isInsidePath(resolvedTmp, canonicalPath(projectRoot)) ||
      isInsidePath(resolvedTmp, canonicalPath(config.backupDir)) ||
      isTempRootUnsafeForGit(resolvedTmp, {
        gitBin: config.gitBin,
        env,
        timeoutMs: config.dockerTimeoutMs,
      })
    ) {
      return reportFailure(config, 'cleanup', EXIT.failed, now);
    }
  } catch {
    return reportFailure(config, 'cleanup', EXIT.failed, now);
  }

  ensurePrivateDir(config.backupDir);
  if (!lock?.held()) return reportBusy(config, now);

  const ledger = new Ledger(config.backupDir);
  docker.bindLedger(ledger);

  let result;
  let saved = false;
  let tempDir = null;
  try {
    await recoverContainers(docker, ledger);
    await sweepStaleTemp(tempRoot, config.backupDir, docker);
    tempDir = mkdtempSync(path.join(tempRoot, TEMP_PREFIX));
    writeFileSync(
      path.join(tempDir, TEMP_MARKER),
      JSON.stringify({ pid: process.pid, backupKey: backupKey(config.backupDir) }),
      { mode: 0o600 }
    );
    result = {
      ok: true,
      ...(await executeBackup({
        config,
        docker,
        now,
        tempDir,
        lock,
        allowRowDrop,
        env,
        publishCopy,
        onBeforeMetaRename,
        projectRoot,
      })),
    };
    saved = true; // publish is the last step that can fail; nothing after it can undo it
  } catch (error) {
    result = classify(error);
  }

  // Containers first. Until every container is proven gone, nothing may be removed under them.
  // A container that stays unproven remains in the ledger, which blocks every later run until
  // it is proven gone; the temporary directory is kept for the same reason.
  let containersGone = false;
  try {
    containersGone = await docker.shutdown();
  } catch {
    containersGone = false;
  }
  if (!containersGone) {
    await releaseQuietly(lock);
    return report(config, now, { ok: false, key: 'containers', exit: EXIT.failed }, saved);
  }

  let removed = true;
  try {
    if (tempDir) removed = await removeTemp(tempDir, docker);
  } catch {
    removed = false;
  }
  // The cleanup container was started after shutdown(): it must be proven gone as well.
  let allGone = false;
  try {
    allGone = await docker.settle();
  } catch {
    allGone = false;
  }
  await releaseQuietly(lock);
  if (!allGone)
    return report(config, now, { ok: false, key: 'containers', exit: EXIT.failed }, saved);
  if (!removed) {
    // Plaintext left on disk is reported even when the copy itself succeeded.
    result = { ok: false, key: 'cleanup', exit: EXIT.failed };
  }
  return report(config, now, result, saved);
}

// Release is the last thing a run does. A failure here cannot leave a live owner behind: the
// descriptor belongs to this process, and the kernel frees the lock when it exits.
async function releaseQuietly(lock) {
  try {
    await lock.release();
  } catch {
    // Nothing more to do: the process is about to exit, and so is its hold on the lock.
  }
}

export function reportFailure(config, key, exit, now = () => new Date(), detail = undefined) {
  return report(config, now, { ok: false, key, exit, detail });
}

// The outcome of a run that could not take the lock. Used by the entry point, which holds no lock
// when another process does.
export function reportBusy(config, now = () => new Date()) {
  return reportFailure(config, 'busy', EXIT.busy, now);
}
