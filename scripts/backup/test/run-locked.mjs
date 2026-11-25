// Test writer: one backup run (or confirmation) as the lock holder, started through launchLocked.
// The request is a JSON object on stdin ({ env, now, tempRoot }). Like cli.mjs, SIGINT, SIGTERM
// and SIGHUP stop the run's containers. The run's result is printed as one JSON line.
import { loadConfig, loadConfirmConfig } from '../config.mjs';
import { confirmEncryptedRestore } from '../confirm.mjs';
import { DockerRunner } from '../docker.mjs';
import { heldLock } from '../lock.mjs';
import { runBackup } from '../pipeline.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const {
  mode = 'backup',
  env,
  now,
  tempRoot,
  allowRowDrop = false,
  confirmFile = null,
  confirmSha256 = null,
  projectRoot,
} = JSON.parse(input);

if (mode === 'confirm') {
  const config = loadConfirmConfig(env);
  const lock = heldLock(config.backupDir, process.env);
  const result = confirmEncryptedRestore({
    config,
    lock,
    fileName: confirmFile,
    expectedSha256: confirmSha256,
    now: () => new Date(now),
    env,
    projectRoot,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  const config = loadConfig(env);
  const lock = heldLock(config.backupDir, process.env);
  const docker = new DockerRunner({
    bin: config.dockerBin,
    containerEnv: config.containerEnv,
    timeoutMs: config.dockerTimeoutMs,
    env,
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      docker.shutdown().catch(() => {});
    });
  }

  const result = await runBackup({
    config,
    docker,
    lock,
    now: () => new Date(now),
    tempRoot,
    allowRowDrop,
    env,
    projectRoot,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
