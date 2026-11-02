import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { POSTGRES_DOCKER_IMAGE } from './postgres-docker-image';

// No dotenv, caller URL or host database: this command owns a fresh, loopback-only container.
const container = `clickmoji-cleanup-test-${randomUUID()}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
try {
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=catalog_cleanup_test',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_DOCKER_IMAGE
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'catalog_cleanup_test');
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const port = docker('port', container, '5432/tcp').match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a loopback-only Docker port');
  const url = `postgresql://postgres@127.0.0.1:${port}/catalog_cleanup_test`;
  const env = { ...process.env, DATABASE_URL: url, INTEGRATION_DATABASE_URL: url };
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env,
    stdio: 'inherit',
  });
  execFileSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'src/lib/services/catalog-cleanup.integration.test.ts',
      '--testTimeout=20000',
    ],
    { env, stdio: 'inherit' }
  );
} finally {
  docker('rm', '--force', container);
}
