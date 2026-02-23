import 'dotenv/config';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';

function timestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

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

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  const pgUrl = sanitizeDatabaseUrl(databaseUrl);

  const customName = process.argv[2]?.trim();
  const backupDir = resolve(process.cwd(), 'backups');
  mkdirSync(backupDir, { recursive: true });

  const fileName = customName
    ? `${customName.replace(/[^a-zA-Z0-9-_]/g, '_')}.dump`
    : `clickmoji-${timestamp()}.dump`;

  console.log(`Creating backup: backups/${fileName}`);

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
    `pg_dump "$DATABASE_URL" -Fc -f "/backups/${fileName}"`,
  ]);

  console.log(`Backup created: backups/${fileName}`);
}

main().catch((error) => {
  console.error('Backup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
