#!/usr/bin/env node
// Records one failed scheduled run when the read-only database address cannot be read from the
// login Keychain (AGE-1669, task Г). Called only by run-scheduled.sh, with BACKUP_DIR and
// BACKUP_STATUS_FILE in the environment. It needs no database address and never reads one.
// The status line goes through the same checks and append protections as every other run.
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfirmConfig } from './config.mjs';
import { EXIT, MESSAGES } from './constants.mjs';
import { reportFailure } from './storage.mjs';

export function recordKeychainFailure(env = process.env) {
  let config;
  try {
    config = loadConfirmConfig(env);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'ошибка конфигурации';
    process.stderr.write(`backup: ${message}\n`);
    return EXIT.failed;
  }
  const result = reportFailure(config, 'noReadonlyRole', EXIT.failed);
  process.stdout.write(`backup: ${MESSAGES.noReadonlyRole}\n`);
  if (!result.statusWritten) process.stdout.write(`backup: ${MESSAGES.status}\n`);
  return result.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = recordKeychainFailure();
}
