import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  buildOfflinePrismaEnv,
  resolveLocalSchemaEngine,
} from '../src/test/offline-postgres-runner-env';

const POSTGRES_IMAGE =
  'postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b';

const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

async function main() {
  docker('image', 'inspect', '--format', '{{.Id}}', POSTGRES_IMAGE);
  const schemaEngine = resolveLocalSchemaEngine(resolve('node_modules/@prisma/engines'));

  const container = `clickmoji-catalog-repair-test-${randomUUID()}`;
  let started = false;

  try {
    docker(
      'run',
      '--detach',
      '--rm',
      '--pull=never',
      '--name',
      container,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=catalog_repair_test',
      '-p',
      '127.0.0.1::5432',
      POSTGRES_IMAGE
    );
    started = true;

    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'catalog_repair_test');
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL did not become ready');
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const port = docker('port', container, '5432/tcp').match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port) throw new Error('Expected a loopback-only Docker port');

    const url = `postgresql://postgres@127.0.0.1:${port}/catalog_repair_test`;
    const env = buildOfflinePrismaEnv(process.env, url, schemaEngine);

    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    execFileSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'src/lib/services/catalog-image-repair.integration.test.ts',
        '--testTimeout=30000',
      ],
      { env, stdio: ['ignore', 'inherit', 'inherit'] }
    );
  } finally {
    if (started) {
      docker('rm', '--force', container);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
