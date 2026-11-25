// Connection settings for the pre-merge production backup (AGE-1667). Derived from DATABASE_URL with
// the same libpqEnv the verified backup CLI uses (scripts/backup/config.mjs), so both describe one
// connection. DATABASE_URL is read from the environment only and is never an argument.
//
//   node scripts/premerge/libpq-env.mjs --names        libpq variable names, one per line (no values)
//   node scripts/premerge/libpq-env.mjs --out FILE     shell `export` lines written to FILE (mode 0600)
//
// Stdout carries ::add-mask:: lines for every value, so the runner hides them in the log.
import { writeFileSync } from 'node:fs';
import { ConfigError, LIBPQ_ENV_NAMES, libpqEnv } from '../backup/config.mjs';

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--names') {
  process.stdout.write(`${LIBPQ_ENV_NAMES.join('\n')}\n`);
  process.exit(0);
}

const outIndex = args.indexOf('--out');
if (args.length !== 2 || outIndex !== 0 || !args[1]) {
  refuse('usage: libpq-env.mjs --names | --out FILE');
}
const outFile = args[1];

const rawUrl = process.env.DATABASE_URL?.trim();
if (!rawUrl) refuse('DATABASE_URL is empty');

let env;
try {
  const protocol = new URL(rawUrl).protocol;
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    refuse('DATABASE_URL must use the postgres scheme');
  }
  env = libpqEnv(rawUrl);
} catch (error) {
  // Fixed texts only: the URL and its parameter names never reach the log.
  const detail = error instanceof ConfigError ? 'an unsupported setting' : 'an unreadable value';
  refuse(`DATABASE_URL has ${detail}`);
}

const entries = Object.entries(env).filter(([, value]) => value !== '');
for (const [, value] of entries) {
  // A line break would split an export line; no libpq setting needs one.
  if (/[\r\n\0]/.test(value)) refuse('a connection value contains a control character');
}

for (const [, value] of entries) {
  process.stdout.write(`::add-mask::${value}\n`);
}

// Single-quoted for the shell: every ' becomes '\'' so no value is ever evaluated.
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const lines = entries.map(([name, value]) => `export ${name}=${quote(value)}`);
writeFileSync(outFile, `${lines.join('\n')}\n`, { mode: 0o600 });
