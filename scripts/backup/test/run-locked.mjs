// Test writer: one backup run as the lock holder, started through launchLocked. The request is a
// JSON object on stdin ({ env, now, tempRoot }). Like cli.mjs, SIGINT, SIGTERM and SIGHUP stop the
// run's containers. The run's result is printed as one JSON line.
import { loadConfig } from '../config.mjs';
import { DockerRunner } from '../docker.mjs';
import { heldLock } from '../lock.mjs';
import { runBackup } from '../pipeline.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { env, now, tempRoot } = JSON.parse(input);

const config = loadConfig(env);
const lock = heldLock(config.backupDir, process.env);
const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, env });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    docker.shutdown().catch(() => {});
  });
}

const result = await runBackup({ config, docker, lock, now: () => new Date(now), tempRoot });
process.stdout.write(`${JSON.stringify(result)}\n`);
