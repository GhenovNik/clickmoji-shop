#!/usr/bin/env node
// Entry point: node scripts/backup/cli.mjs [--allow-row-drop]
// Required environment (values are never printed):
//   DATABASE_URL                  source database (postgres://), forwarded to containers by name
//   BACKUP_DIR                    explicit absolute directory (e.g. main checkout's gitignored backups/)
//   BACKUP_STATUS_FILE            absolute status file outside the repository and backup directory
// Optional:
//   BACKUP_ENCRYPT                0/false (default, unencrypted pg_dump -Fc) or 1/true (age encryption)
//   BACKUP_AGE_RECIPIENT_FILE     required when BACKUP_ENCRYPT=1; file holding one public age key (age1...)
//   BACKUP_RETENTION_COUNT        number of latest successful copies to keep (integer >= 1, default 2)
//   BACKUP_DOCKER_BIN             docker binary (default "docker")
//   BACKUP_GIT_BIN                git binary (default "git")
//   BACKUP_DOCKER_TIMEOUT_MS      ms a management docker/git call may take before kill (default 20000)
// Single-run flag:
//   --allow-row-drop              accepts >20% table row drop for this run only and updates baseline
// Exit codes: 0 ok, 1 failed (old copies intact), 2 rejected (>20% row drop without --allow-row-drop),
// 3 busy, 4 docker, image or git unavailable, 5 copy published but its status line could not be written,
// 130 interrupted.
// Configuration is read only from the environment (see config.mjs). The database address
// is never printed, passed in argv, or written to the status file.
//
// Two processes run for one backup. The one started by the user holds no lock: it starts this
// same file under the lock launcher (lock.mjs), which execs the writer in place. The writer is the
// process that does the work, and it owns the locked descriptor (BACKUP_LOCK_FD) for its whole run.
// Signals sent to the starter are forwarded to the writer; the starter returns the writer's status.
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigError, loadBaseConfig, loadConfig, parseCliArgs } from './config.mjs';
import { MESSAGES } from './constants.mjs';
import { DockerRunner } from './docker.mjs';
import { canonicalPath, isInsidePath, verifyBackupDirGitIgnored } from './git.mjs';
import { heldLock, LAUNCH_BUSY, LAUNCH_FAILED, LOCK_FD_ENV, launchLocked } from './lock.mjs';
import { reportBusy, reportFailure, runBackup } from './pipeline.mjs';

const SELF = fileURLToPath(import.meta.url);
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function tryRecordConfigFailure(env, message) {
  let base;
  try {
    base = loadBaseConfig(env);
  } catch {
    return;
  }
  const gitCheck = verifyBackupDirGitIgnored({
    backupDir: base.backupDir,
    gitBin: base.gitBin,
    env,
    timeoutMs: base.dockerTimeoutMs,
  });
  if (
    (gitCheck.repoRoot && isInsidePath(canonicalPath(base.statusFile), gitCheck.repoRoot)) ||
    (gitCheck.projectTopLevel &&
      isInsidePath(canonicalPath(base.statusFile), gitCheck.projectTopLevel))
  ) {
    return;
  }
  reportFailure(base, 'internal', 1, () => new Date(), `сбой: ${message}`);
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  let cliOptions;
  try {
    cliOptions = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'ошибка конфигурации';
    process.stderr.write(`backup: ${message}\n`);
    return 1;
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'ошибка конфигурации';
    if (error instanceof ConfigError && message.startsWith('BACKUP_AGE_RECIPIENT_FILE')) {
      tryRecordConfigFailure(env, message);
    }
    process.stderr.write(`backup: ${message}\n`);
    return 1;
  }

  if (env[LOCK_FD_ENV] === undefined) {
    // Check git ignore before launchLocked so a non-ignored directory or missing git never
    // creates backupDir or .backup.lock inside the repository.
    const gitCheck = verifyBackupDirGitIgnored({
      backupDir: config.backupDir,
      gitBin: config.gitBin,
      env,
      timeoutMs: config.dockerTimeoutMs,
    });
    if (
      (gitCheck.repoRoot && isInsidePath(canonicalPath(config.statusFile), gitCheck.repoRoot)) ||
      (gitCheck.projectTopLevel &&
        isInsidePath(canonicalPath(config.statusFile), gitCheck.projectTopLevel))
    ) {
      process.stderr.write('backup: BACKUP_STATUS_FILE: путь внутри репозитория\n');
      return 1;
    }
    if (!gitCheck.ok) {
      reportFailure(config, gitCheck.key, gitCheck.exit);
      process.stdout.write(`backup: ${MESSAGES[gitCheck.key]}\n`);
      return gitCheck.exit;
    }
    return startWriter(config, env, argv);
  }

  // The writer. Without its descriptor, nothing is written.
  const lock = heldLock(config.backupDir, env);
  if (!lock) {
    process.stderr.write('backup: блокировка недоступна\n');
    return 1;
  }

  const docker = new DockerRunner({
    bin: config.dockerBin,
    containerEnv: config.containerEnv,
    timeoutMs: config.dockerTimeoutMs,
    env,
  });
  // The run stops its containers (and proves them gone), then removes plaintext, releases the
  // lock and writes the status line before it returns; the exit code reflects the interruption.
  for (const signal of FORWARDED) {
    process.on(signal, () => {
      docker.shutdown().catch(() => {}); // the run reports the outcome when it ends
    });
  }

  const result = await runBackup({
    config,
    docker,
    lock,
    allowRowDrop: cliOptions.allowRowDrop,
    env,
  });
  const summary = result.ok
    ? `backup: ok ${result.name} verify=${result.verify}`
    : `backup: ${MESSAGES[result.key]}`;
  process.stdout.write(`${summary}\n`);
  if (!result.statusWritten) {
    process.stdout.write(`backup: ${MESSAGES[result.saved ? 'statusSaved' : 'status']}\n`);
  }
  return result.exit;
}

// Starts the writer under the lock. Busy (or a launcher that cannot run) is reported here, as the
// run that did not start; anything else is the writer's own status.
async function startWriter(config, env, argv) {
  const writer = launchLocked(config.backupDir, [process.execPath, SELF, ...argv], { env });
  for (const signal of FORWARDED) {
    process.on(signal, () => {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill(signal);
    });
  }
  const status = await new Promise((resolve) => {
    writer.once('error', () => resolve({ code: LAUNCH_FAILED, signal: null }));
    writer.once('exit', (code, signal) => resolve({ code, signal }));
  });

  if (status.code === LAUNCH_BUSY || status.code === LAUNCH_FAILED) {
    const result = reportBusy(config);
    process.stdout.write(`backup: ${MESSAGES.busy}\n`);
    return result.exit;
  }
  if (status.signal) return 128 + (os.constants.signals[status.signal] ?? 0);
  return status.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('backup: внутренняя ошибка\n');
      process.exitCode = 1;
    }
  );
}
