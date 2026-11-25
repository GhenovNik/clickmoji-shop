#!/usr/bin/env bash
# Read-only check before production access and again right before the migration (AGE-1667).
# Fetches PR #160 and the comparison of live master with the reviewed commit through the GitHub API,
# then hands both to verify-pr.mjs. Needs GH_TOKEN (read-only: contents and pull requests),
# GITHUB_REPOSITORY and REVIEWED_SHA. Makes no write call.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

repo="${GITHUB_REPOSITORY:-}"
sha="${REVIEWED_SHA:-}"

if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "REFUSED: GITHUB_REPOSITORY is not OWNER/NAME; nothing was applied"
  exit 1
fi
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "REFUSED: reviewed SHA is not a full lowercase commit SHA; nothing was applied"
  exit 1
fi

tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/premerge-pr.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

gh api "repos/$repo/pulls/160" > "$tmp/pr.json" \
  || { echo "REFUSED: could not read PR #160; nothing was applied"; exit 1; }
gh api "repos/$repo/compare/master...$sha" > "$tmp/compare.json" \
  || { echo "REFUSED: could not compare live master with the reviewed commit; nothing was applied"; exit 1; }

node "$HERE/verify-pr.mjs" --repo "$repo" --sha "$sha" \
  --pr-json "$tmp/pr.json" --compare-json "$tmp/compare.json"
