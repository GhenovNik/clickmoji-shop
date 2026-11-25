import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  buildOfflinePrismaEnv,
  resolveLocalSchemaEngine,
} from '../src/test/offline-postgres-runner-env';

// Pre-staged local immutable digest of postgres:17-alpine; never pull during offline tests.
const LEGACY_LOCALES_POSTGRES_IMAGE =
  'postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b';

function formatCommandError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderrValue = (error as { stderr?: unknown }).stderr;
  const stderrText =
    typeof stderrValue === 'string'
      ? stderrValue.trim()
      : Buffer.isBuffer(stderrValue)
        ? stderrValue.toString('utf8').trim()
        : '';
  if (stderrText && !error.message.includes(stderrText)) {
    return `${error.message}: ${stderrText}`;
  }
  return error.message;
}

const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function assertLocalPinnedImageAvailable(image: string): void {
  let imageId: string;
  try {
    imageId = docker('image', 'inspect', '--format', '{{.Id}}', image);
  } catch (error) {
    throw new Error(
      `Offline PostgreSQL prerequisite failed: pre-staged local pinned image "${image}" is unavailable (no pull will be attempted): ${formatCommandError(error)}`
    );
  }
  if (!imageId) {
    throw new Error(
      `Offline PostgreSQL prerequisite failed: pre-staged local pinned image "${image}" returned an empty image ID`
    );
  }
}

async function main() {
  // Verify the pinned image exists locally before creating or cleaning up any container.
  assertLocalPinnedImageAvailable(LEGACY_LOCALES_POSTGRES_IMAGE);
  // Likewise the Prisma schema engine must already be installed; the CLI must never download it.
  const schemaEngine = resolveLocalSchemaEngine(resolve('node_modules/@prisma/engines'));

  // No dotenv, caller URL or host database: this command owns a fresh, loopback-only container.
  const container = `clickmoji-legacy-locales-test-${randomUUID()}`;
  let containerStarted = false;
  let primaryError: unknown;

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
      'POSTGRES_DB=legacy_locales_test',
      '-p',
      '127.0.0.1::5432',
      LEGACY_LOCALES_POSTGRES_IMAGE
    );
    containerStarted = true;

    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'legacy_locales_test');
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const port = docker('port', container, '5432/tcp').match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port) throw new Error('Expected a loopback-only Docker port');

    const url = `postgresql://postgres@127.0.0.1:${port}/legacy_locales_test`;
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
        'src/lib/services/emoji-legacy-ru-locales.integration.test.ts',
        '--testTimeout=30000',
      ],
      { env, stdio: ['ignore', 'inherit', 'inherit'] }
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (containerStarted) {
      try {
        docker('rm', '--force', container);
      } catch (cleanupError) {
        const cleanupMessage = formatCommandError(cleanupError);
        if (primaryError !== undefined) {
          console.error(
            `Warning: failed to remove disposable PostgreSQL container ${container}: ${cleanupMessage}`
          );
        } else {
          throw new Error(
            `Failed to remove disposable PostgreSQL container ${container}: ${cleanupMessage}`
          );
        }
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(formatCommandError(error));
  process.exitCode = 1;
});
