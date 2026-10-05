import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNpmAuditRunner } from '../src/lib/audit/npm-runner';
import { runAuditCheck } from '../src/lib/audit/run';
import { printable } from '../src/lib/audit/text';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'audit-allowlist.json');
const NPMRC_PATH = path.join(REPO_ROOT, '.npmrc');

async function main() {
  const decision = await runAuditCheck({
    runner: createNpmAuditRunner(),
    readAllowlistFile: () =>
      existsSync(ALLOWLIST_PATH) ? readFileSync(ALLOWLIST_PATH, 'utf8') : null,
    findProjectNpmrc: () => (existsSync(NPMRC_PATH) ? NPMRC_PATH : null),
  });

  for (const line of decision.lines) {
    console.log(line);
  }

  process.exitCode = decision.exitCode;
}

main().catch((error: unknown) => {
  console.error(
    `audit-check: error [process]: ${printable(error instanceof Error ? error.message : error)}`
  );
  process.exitCode = 1;
});
