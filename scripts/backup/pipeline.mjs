// One verified backup run: dump -> restore and compare -> [encrypt] -> git check -> publish -> prune.
// Plaintext and the temporary PostgreSQL cluster live only in a private temp directory outside any
// repository, removed on success, failure and interruption. When encryption is off (default), the
// verified custom-format dump is stored in backupDir as an explicit operator exception; when
// encryption is enabled, only ciphertext enters backupDir, and prior unencrypted copies are purged
// only after explicit operator restore confirmation AND the next successful encrypted publish.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  BACKUP_ENCRYPTED_SUFFIX,
  BACKUP_PLAIN_SUFFIX,
  BACKUP_PREFIX,
  BUILD_TIMEOUT_MS,
  DROP_THRESHOLD_PERCENT,
  EXIT,
  META_DIR,
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
import { REPO_ROOT } from './config.mjs';
import {
  clearConfirmationState,
  confirmationTargetPaths,
  readConfirmationState,
  validateConfirmationForTransition,
} from './confirm.mjs';
import {
  canonicalPath,
  isInsidePath,
  isTempRootUnsafeForGit,
  verifyBackupDirGitIgnored,
} from './git.mjs';
import { pidAlive } from './lock.mjs';
import { Ledger, LedgerError } from './ledger.mjs';
import { selectRetention, selectTransitionRetention } from './retention.mjs';
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
import {
  cleanupIncompletePublishes,
  ensurePrivateDir,
  fsyncFile,
  listBackups,
  removeCopyWithMeta,
  report,
  reportBusy,
  reportFailure,
  sha256File,
  sha256Text,
  stamp,
  StepError,
  writePrivateCopy,
  writePrivateText,
} from './storage.mjs';

export { listBackups, reportBusy, reportFailure, stamp, StepError, writePrivateCopy };

const containerName = (step) => `clickmoji-backup-${step}-${crypto.randomBytes(6).toString('hex')}`;

function isNonEmptyFile(file) {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
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
  // Fail closed early if an existing confirmation state file is corrupted, symlinked, or hardlinked.
  readConfirmationState(config.backupDir);

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

  // Re-check git ignore on the exact physical temporary and final paths (including metadata and
  // confirmation state) right before writing to backupDir.
  const targetPaths = [
    path.join(config.backupDir, `.partial-${name}`),
    path.join(config.backupDir, name),
    path.join(config.backupDir, META_DIR, `.partial-${name}.json`),
    path.join(config.backupDir, META_DIR, `${name}.json`),
    ...confirmationTargetPaths(config.backupDir),
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
    sha256: sha256File(sourceToPublish),
    verify: 'ok',
    verifyScope: 'plaintext',
    ...(config.encrypt && config.recipient
      ? { recipientSha256: sha256Text(config.recipient) }
      : {}),
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
  let waitingForConfirmation = false;
  if (!lock.held()) {
    pruned = 'skipped';
  } else {
    try {
      cleanupIncompletePublishes(config.backupDir);
      const entries = listBackups(config.backupDir);
      if (config.encrypt) {
        const hasPlain = entries.some((entry) => !entry.encrypted);
        if (hasPlain) {
          const validation = validateConfirmationForTransition({
            backupDir: config.backupDir,
            entries,
            currentRecipient: config.recipient,
          });
          const plan = selectTransitionRetention({
            entries,
            keepCount: config.keepCount,
            encrypt: true,
            confirmed: validation.valid,
          });
          waitingForConfirmation = plan.waitingForConfirmation;
          for (const old of plan.remove) {
            removeCopyWithMeta(config.backupDir, old);
          }
          if (
            validation.valid &&
            !listBackups(config.backupDir).some((entry) => !entry.encrypted)
          ) {
            clearConfirmationState(config.backupDir);
          }
        } else {
          const { remove } = selectRetention(entries, config.keepCount);
          for (const old of remove) {
            removeCopyWithMeta(config.backupDir, old);
          }
          clearConfirmationState(config.backupDir);
        }
      } else {
        const { remove } = selectRetention(entries, config.keepCount);
        for (const old of remove) {
          removeCopyWithMeta(config.backupDir, old);
        }
        // Any successful unencrypted publication starts a fresh unencrypted baseline and
        // invalidates any older encrypted-restore confirmation.
        clearConfirmationState(config.backupDir);
      }
    } catch {
      pruned = 'incomplete';
      waitingForConfirmation =
        config.encrypt && listBackups(config.backupDir).some((entry) => !entry.encrypted);
    }
  }
  return { name, sizeBytes: meta.sizeBytes, verify: 'ok', pruned, waitingForConfirmation };
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
    targetPaths: confirmationTargetPaths(config.backupDir),
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
