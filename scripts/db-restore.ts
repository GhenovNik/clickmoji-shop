import 'dotenv/config';
import { readdirSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) return resolvePromise();
      rejectPromise(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function sanitizeDatabaseUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.searchParams.delete('schema');
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString();
}

function getLatestDumpFile(backupDir: string): string {
  const dumps = readdirSync(backupDir)
    .filter((file) => file.endsWith('.dump'))
    .sort((a, b) => b.localeCompare(a));

  if (dumps.length === 0) {
    throw new Error('No .dump files found in backups directory');
  }

  const latest = dumps[0];
  if (!latest) {
    throw new Error('No .dump files found in backups directory');
  }
  return latest;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  const pgUrl = sanitizeDatabaseUrl(databaseUrl);

  const backupDir = resolve(process.cwd(), 'backups');
  const requestedFile = process.argv[2]?.trim();
  const fileName = requestedFile || getLatestDumpFile(backupDir);

  console.log(`Restoring from: backups/${fileName}`);
  console.log('Warning: current data in target DB will be overwritten.');

  await run('docker', [
    'run',
    '--rm',
    '-e',
    `DATABASE_URL=${pgUrl}`,
    '--mount',
    `type=bind,source=${backupDir},target=/backups`,
    'postgres:16-alpine',
    'sh',
    '-lc',
    `pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" "/backups/${fileName}"`,
  ]);

  console.log(`Restore completed from backups/${fileName}`);
}

main().catch((error) => {
  console.error('Restore failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
