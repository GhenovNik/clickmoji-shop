#!/usr/bin/env node
// Entry point: node scripts/backup/cli.mjs
// Required environment (values are never printed):
//   DATABASE_URL                  source database (postgres://), forwarded to containers by name
//   BACKUP_DIR                    absolute directory outside the repository
//   BACKUP_STATUS_FILE            absolute status file outside the repository
//   BACKUP_AGE_RECIPIENT_FILE     file holding one public age recipient (age1...)
// Optional: BACKUP_DOCKER_BIN (default "docker").
// Exit codes: 0 ok, 1 failed (old copies intact), 2 published but flagged, 3 busy,
// 4 docker or image unavailable, 130 interrupted.
// Configuration is read only from the environment (see config.mjs). The database address
// is never printed, passed in argv, or written to the status file.
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig } from './config.mjs';
import { MESSAGES } from './constants.mjs';
import { DockerRunner } from './docker.mjs';
import { runBackup } from './pipeline.mjs';

export async function main(env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'ошибка конфигурации';
    process.stderr.write(`backup: ${message}\n`);
    return 1;
  }

  const docker = new DockerRunner({
    bin: config.dockerBin,
    containerDatabaseUrl: config.containerDatabaseUrl,
    env,
  });
  // The run finishes its cleanup (kill containers, remove plaintext, release the lock,
  // write the status line) and then returns; the exit code reflects the interruption.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      docker.abort();
    });
  }

  const result = await runBackup({ config, docker });
  const summary = result.ok
    ? `backup: ok ${result.name} verify=${result.verify}`
    : `backup: ${MESSAGES[result.key]}`;
  process.stdout.write(`${summary}\n`);
  return result.exit;
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
