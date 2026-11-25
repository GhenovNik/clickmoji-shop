// Offline checks of the pre-merge wiring in .github/workflows/migrate-production.yml (AGE-1667).
// The workflow text is read as data; nothing is run against GitHub.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { BACKUP_NAME_PATTERN } from '../../backup/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/migrate-production.yml'), 'utf8');
const premergeJob = WORKFLOW.slice(WORKFLOW.indexOf('  premerge-migrate:'));

// The bash regex the validate job applies to backup_age_file, copied verbatim from the workflow.
const backupRegex = (() => {
  const line = WORKFLOW.split('\n').find((text) => text.includes('[[ "$BACKUP_FILE" =~ '));
  assert.ok(line, 'validate job checks BACKUP_FILE');
  const match = line.match(/=~ (.+?) \]\]/);
  assert.ok(match, 'regex found on the BACKUP_FILE line');
  return match[1];
})();

const accepts = (name) =>
  spawnSync('bash', ['-c', `[[ "$1" =~ ${backupRegex} ]]`, '_', name]).status === 0;

describe('B1: backup file name matches what the backup CLI writes', () => {
  it('the regex is the canonical CLI grammar, not a second copy of it', () => {
    assert.equal(backupRegex, '^clickmoji-[0-9]{8}T[0-9]{6}Z\\.dump\\.age$');
    assert.ok(BACKUP_NAME_PATTERN.test('clickmoji-20261124T093000Z.dump.age'));
  });

  it('accepts a name in the CLI form (positive fixture)', () => {
    assert.equal(accepts('clickmoji-20261124T093000Z.dump.age'), true);
  });

  it('refuses the old dashed form that the previous validator wanted (negative fixture)', () => {
    assert.equal(accepts('clickmoji-20261124-093000.dump.age'), false);
  });

  it('refuses names that only look right: extra suffix, path, wrong prefix, missing Z', () => {
    for (const bad of [
      'clickmoji-20261124T093000Z.dump.age.tmp',
      '../clickmoji-20261124T093000Z.dump.age',
      'other-20261124T093000Z.dump.age',
      'clickmoji-20261124T093000.dump.age',
      'neon-prod-premigrate-20261124-093000.dump',
    ]) {
      assert.equal(accepts(bad), false, bad);
    }
  });
});

describe('B2: the pre-merge backup keeps the source connection out of argv', () => {
  it('the job runs the premerge backup script, not inline docker commands with a DSN', () => {
    assert.match(premergeJob, /bash scripts\/premerge\/prod-backup\.sh dump "\$FILE_NAME"/);
    assert.match(premergeJob, /bash scripts\/premerge\/prod-backup\.sh restore "\$FILE_NAME"/);
    assert.doesNotMatch(premergeJob, /-e DATABASE_URL/);
    assert.doesNotMatch(premergeJob, /pg_dump \\"\\\$DATABASE_URL/);
  });

  it('the restore check stays in the job, before the migration', () => {
    const restoreAt = premergeJob.indexOf('prod-backup.sh restore');
    const applyAt = premergeJob.indexOf('npx prisma migrate deploy');
    assert.ok(restoreAt > 0 && applyAt > restoreAt, 'restore runs before migrate deploy');
  });

  it('the premerge job reads the premerge secret only in the dump and apply steps', () => {
    const uses = premergeJob.split('\n').filter((line) => line.includes('secrets.'));
    assert.equal(uses.length, 2);
    assert.ok(uses.every((line) => line.includes('secrets.PREMERGE_PROD_DATABASE_URL')));
    assert.equal(WORKFLOW.includes('secrets.PREMERGE_PROD_DATABASE_URL'), true);
  });
});

describe('B3: read-only PR check before production access and before DDL', () => {
  it('runs verify-pr.sh before the backup and again right before the migration', () => {
    const calls = premergeJob.split('\n').filter((line) => line.includes('verify-pr.sh'));
    assert.equal(calls.length, 2);
    const first = premergeJob.indexOf('verify-pr.sh');
    const dump = premergeJob.indexOf('prod-backup.sh dump');
    const second = premergeJob.lastIndexOf('verify-pr.sh');
    const apply = premergeJob.indexOf('npx prisma migrate deploy');
    assert.ok(first < dump, 'first check precedes the first production access');
    assert.ok(
      second > premergeJob.indexOf('prod-backup.sh restore') && second < apply,
      'second check precedes DDL'
    );
  });

  it('the job token is read-only: contents read and pull requests read, nothing else', () => {
    assert.match(premergeJob, /permissions:\n {6}contents: read\n {6}pull-requests: read\n/);
    assert.doesNotMatch(premergeJob.slice(0, premergeJob.indexOf('steps:')), /write/);
  });

  it('the job stays bound to the protected environment', () => {
    assert.match(premergeJob, /environment: production-migration-premerge/);
  });
});
