// Decides whether the pre-merge production migration may still run (AGE-1667). Pure: it reads two
// JSON files that verify-pr.sh fetched with a read-only token, and makes no network call itself.
//
// The reviewed commit must be the open head of PR #160 in this repository, and live master must be
// an ancestor of that commit (compare master...SHA: nothing on master is missing from the commit).
//
//   node scripts/premerge/verify-pr.mjs --repo OWNER/NAME --sha SHA --pr-json FILE --compare-json FILE
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PREMERGE_PR = Object.freeze({
  number: 160,
  branch: 'feature/age-1667-localized-picture-fields',
  base: 'master',
});

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Returns { ok, reasons }. Reasons are fixed texts: they never echo GitHub data.
export function evaluatePremerge({ pr, compare, sha, repo }) {
  const reasons = [];
  const need = (ok, reason) => {
    if (!ok) reasons.push(reason);
  };

  need(
    typeof sha === 'string' && FULL_SHA.test(sha),
    'reviewed SHA is not a full lowercase commit SHA'
  );
  need(typeof repo === 'string' && REPO.test(repo), 'repository name is not OWNER/NAME');
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
    reasons.push('pull request data is missing');
  } else {
    need(pr.number === PREMERGE_PR.number, `PR is not #${PREMERGE_PR.number}`);
    need(pr.state === 'open', 'PR is not open');
    need(pr.merged_at == null && pr.merged !== true, 'PR is already merged');
    need(pr.head?.ref === PREMERGE_PR.branch, 'PR head branch is not the reviewed branch');
    need(pr.head?.repo?.full_name === repo, 'PR head is not in this repository (fork or deleted)');
    need(pr.base?.ref === PREMERGE_PR.base, 'PR base is not master');
    need(pr.base?.repo?.full_name === repo, 'PR base is not in this repository');
    need(
      typeof sha === 'string' && pr.head?.sha === sha,
      'PR head is not the reviewed commit: the branch moved; re-review and dispatch again'
    );
  }

  if (!compare || typeof compare !== 'object' || Array.isArray(compare)) {
    reasons.push('master comparison data is missing');
  } else {
    need(
      compare.status === 'ahead' || compare.status === 'identical',
      'live master is not an ancestor of the reviewed commit'
    );
    need(compare.behind_by === 0, 'reviewed commit lacks commits that are now on master');
    need(
      Boolean(compare.merge_base_commit?.sha) &&
        compare.merge_base_commit.sha === compare.base_commit?.sha,
      'merge base is not the live master tip'
    );
  }

  return { ok: reasons.length === 0, reasons };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--repo', '--sha', '--pr-json', '--compare-json'].includes(key) || value === undefined) {
      return null;
    }
    opts[key.slice(2)] = value;
  }
  return opts.repo && opts.sha && opts['pr-json'] && opts['compare-json'] ? opts : null;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) {
    console.log(
      'REFUSED: usage: verify-pr.mjs --repo OWNER/NAME --sha SHA --pr-json FILE --compare-json FILE'
    );
    return 2;
  }
  const pr = readJson(opts['pr-json']);
  const compare = readJson(opts['compare-json']);
  if (pr === undefined || compare === undefined) {
    console.log('REFUSED: GitHub response is not valid JSON; nothing was applied');
    return 1;
  }
  const result = evaluatePremerge({ pr, compare, sha: opts.sha, repo: opts.repo });
  if (result.ok) {
    console.log(
      `OK: PR #${PREMERGE_PR.number} is open, its head is the reviewed commit, live master is an ancestor`
    );
    return 0;
  }
  for (const reason of result.reasons) console.log(`REFUSED: ${reason}`);
  console.log('No production secret was read and no database was touched.');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
