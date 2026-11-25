// Offline tests for the read-only PR and master check (AGE-1667). No network: every input is a fixture,
// and the shell wrapper is exercised with a fake gh on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { evaluatePremerge } from '../verify-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREMERGE = path.join(HERE, '..');
const BRANCH = 'feature/age-1667-localized-picture-fields';
const REPO = 'GhenovNik/clickmoji-shop';
const SHA = 'e6569c3ff68540906f2b6896f317ac3140549772';
const STALE = '0123456789abcdef0123456789abcdef01234567';
const MASTER = 'b4f56d8eda871ba0c44571008b731c1356aaca5e';

const goodPr = () => ({
  number: 160,
  state: 'open',
  merged_at: null,
  merged: false,
  head: { ref: BRANCH, sha: SHA, repo: { full_name: REPO } },
  base: { ref: 'master', repo: { full_name: REPO } },
});

const goodCompare = () => ({
  status: 'ahead',
  ahead_by: 3,
  behind_by: 0,
  base_commit: { sha: MASTER },
  merge_base_commit: { sha: MASTER },
});

const check = (over = {}) =>
  evaluatePremerge({ pr: goodPr(), compare: goodCompare(), sha: SHA, repo: REPO, ...over });

describe('evaluatePremerge (positive and negative controls)', () => {
  it('accepts the open PR whose head is the reviewed commit and that contains live master', () => {
    assert.deepEqual(check(), { ok: true, reasons: [] });
  });

  it('accepts an identical comparison (head equal to master)', () => {
    const compare = { ...goodCompare(), status: 'identical', ahead_by: 0 };
    assert.equal(check({ compare }).ok, true);
  });

  it('refuses a stale SHA: the branch moved after review', () => {
    const pr = goodPr();
    pr.head.sha = STALE;
    const result = check({ pr });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /branch moved/);
  });

  it('refuses a dispatched SHA that is not the PR head even when the PR head is valid', () => {
    assert.equal(check({ sha: STALE }).ok, false);
  });

  it('refuses a wrong head branch', () => {
    const pr = goodPr();
    pr.head.ref = 'feature/something-else';
    assert.match(check({ pr }).reasons.join('\n'), /head branch is not the reviewed branch/);
  });

  it('refuses a wrong base branch', () => {
    const pr = goodPr();
    pr.base.ref = 'main';
    assert.match(check({ pr }).reasons.join('\n'), /base is not master/);
  });

  it('refuses a closed PR', () => {
    const pr = goodPr();
    pr.state = 'closed';
    assert.match(check({ pr }).reasons.join('\n'), /not open/);
  });

  it('refuses an already merged PR', () => {
    const pr = goodPr();
    pr.merged_at = '2026-11-24T10:00:00Z';
    pr.merged = true;
    assert.match(check({ pr }).reasons.join('\n'), /already merged/);
  });

  it('refuses a head from a fork, and a head whose repository was deleted', () => {
    const fork = goodPr();
    fork.head.repo = { full_name: 'someone/clickmoji-shop' };
    assert.match(check({ pr: fork }).reasons.join('\n'), /not in this repository/);
    const deleted = goodPr();
    deleted.head.repo = null;
    assert.equal(check({ pr: deleted }).ok, false);
  });

  it('refuses any PR number other than #160', () => {
    const pr = goodPr();
    pr.number = 161;
    assert.match(check({ pr }).reasons.join('\n'), /PR is not #160/);
  });

  it('refuses when live master is ahead of the reviewed commit (diverged or behind)', () => {
    const diverged = { ...goodCompare(), status: 'diverged', behind_by: 2 };
    assert.equal(check({ compare: diverged }).ok, false);
    const behind = { ...goodCompare(), status: 'behind', behind_by: 4 };
    assert.equal(check({ compare: behind }).ok, false);
  });

  it('refuses when the merge base is not the live master tip', () => {
    const compare = goodCompare();
    compare.merge_base_commit = { sha: STALE };
    assert.match(check({ compare }).reasons.join('\n'), /merge base is not the live master tip/);
  });

  it('fails closed on missing or malformed data', () => {
    assert.equal(check({ pr: undefined }).ok, false);
    assert.equal(check({ pr: [] }).ok, false);
    assert.equal(check({ compare: null }).ok, false);
    assert.equal(check({ compare: { status: 'ahead' } }).ok, false);
    assert.equal(check({ sha: SHA.toUpperCase() }).ok, false);
    assert.equal(check({ sha: 'e6569c3' }).ok, false);
    assert.equal(check({ repo: 'not a repo' }).ok, false);
    assert.equal(check({ repo: undefined }).ok, false);
  });
});

describe('verify-pr.mjs command line', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'premerge-verify-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (pr, compare, extra = {}) => {
    const prFile = path.join(dir, 'pr.json');
    const compareFile = path.join(dir, 'compare.json');
    writeFileSync(prFile, typeof pr === 'string' ? pr : JSON.stringify(pr));
    writeFileSync(compareFile, typeof compare === 'string' ? compare : JSON.stringify(compare));
    return spawnSync(
      process.execPath,
      [
        path.join(PREMERGE, 'verify-pr.mjs'),
        '--repo',
        extra.repo ?? REPO,
        '--sha',
        extra.sha ?? SHA,
        '--pr-json',
        prFile,
        '--compare-json',
        compareFile,
      ],
      { encoding: 'utf8' }
    );
  };

  it('exits 0 on the good fixture', () => {
    const result = run(goodPr(), goodCompare());
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^OK: PR #160 is open/);
  });

  it('exits 1 with a REFUSED line on a stale SHA', () => {
    const pr = goodPr();
    pr.head.sha = STALE;
    const result = run(pr, goodCompare());
    assert.equal(result.status, 1);
    assert.match(result.stdout, /REFUSED: PR head is not the reviewed commit/);
  });

  it('exits 1 on a response that is not JSON', () => {
    const result = run('<html>rate limited</html>', goodCompare());
    assert.equal(result.status, 1);
    assert.match(result.stdout, /not valid JSON/);
  });

  it('exits 2 on bad usage', () => {
    const result = spawnSync(process.execPath, [path.join(PREMERGE, 'verify-pr.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
  });
});

describe('verify-pr.sh with a fake read-only gh', () => {
  let dir;
  let env;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'premerge-verify-sh-'));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const log = path.join(dir, 'gh.log');
    const gh = path.join(bin, 'gh');
    writeFileSync(
      gh,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$2" in
  repos/*/pulls/160) cat "$FAKE_PR" ;;
  repos/*/compare/master...*) cat "$FAKE_COMPARE" ;;
  *) echo "unexpected gh call" >&2; exit 9 ;;
esac
`
    );
    chmodSync(gh, 0o755);
    writeFileSync(path.join(dir, 'pr.json'), JSON.stringify(goodPr()));
    writeFileSync(path.join(dir, 'compare.json'), JSON.stringify(goodCompare()));
    env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_TOKEN: 'read-only-test-token',
      GITHUB_REPOSITORY: REPO,
      REVIEWED_SHA: SHA,
      RUNNER_TEMP: dir,
      FAKE_PR: path.join(dir, 'pr.json'),
      FAKE_COMPARE: path.join(dir, 'compare.json'),
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const script = () =>
    spawnSync('bash', [path.join(PREMERGE, 'verify-pr.sh')], { env, encoding: 'utf8' });
  const calls = () => readFileSync(path.join(dir, 'gh.log'), 'utf8');

  it('accepts the good PR and only issues GET calls', () => {
    const result = script();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(calls(), /repos\/GhenovNik\/clickmoji-shop\/pulls\/160/);
    assert.match(calls(), /compare\/master\.\.\.e6569c3/);
    assert.doesNotMatch(calls(), /-X|--method|POST|PATCH|PUT|DELETE/);
  });

  it('refuses a stale reviewed SHA', () => {
    writeFileSync(
      path.join(dir, 'pr.json'),
      JSON.stringify({ ...goodPr(), head: { ...goodPr().head, sha: STALE } })
    );
    const result = script();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /REFUSED: PR head is not the reviewed commit/);
  });

  it('refuses when the API cannot be read, and does not continue', () => {
    env.FAKE_PR = path.join(dir, 'missing.json');
    const result = script();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /could not read PR #160/);
  });

  it('refuses a malformed reviewed SHA before any API call', () => {
    env.REVIEWED_SHA = 'main';
    const result = script();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /not a full lowercase commit SHA/);
    assert.equal(existsSync(path.join(dir, 'gh.log')), false);
  });
});
