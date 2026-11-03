import 'dotenv/config';
import { execFileSync, spawnSync } from 'node:child_process';

// Deliberately restricted to the restored Docker database used for this regression.
// Never silently point a write-capable integration test at the caller's production URL.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const target = new URL(url);
if (!['localhost', '127.0.0.1'].includes(target.hostname) || (target.port || '5432') !== '5432') {
  throw new Error('Refusing non-local database: expected clickmoji-local-pg on loopback:5432');
}
const running = execFileSync(
  'docker',
  ['inspect', '-f', '{{.State.Running}}', 'clickmoji-local-pg'],
  {
    encoding: 'utf8',
  }
).trim();
const ports = execFileSync('docker', ['port', 'clickmoji-local-pg', '5432/tcp'], {
  encoding: 'utf8',
});
if (running !== 'true' || !ports.split('\n').some((port) => port.endsWith(':5432'))) {
  throw new Error('Expected running clickmoji-local-pg published on port 5432');
}
const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'src/app/api/item-duplicates.integration.test.ts'],
  { env: { ...process.env, INTEGRATION_DATABASE_URL: url }, stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
