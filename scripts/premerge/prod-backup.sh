#!/usr/bin/env bash
# Pre-merge production backup and restore check (AGE-1667). Called only by
# .github/workflows/migrate-production.yml, in the protected job.
#
#   prod-backup.sh dump    FILE DIR   needs DATABASE_URL (protected environment secret)
#   prod-backup.sh restore FILE DIR   restores DIR/FILE into a scratch PostgreSQL 17, then deletes it
#
# Boundary for the source connection:
#   - DATABASE_URL is turned into libpq PG* variables by libpqEnv (scripts/backup/config.mjs).
#   - docker receives variable NAMES only (-e PGHOST), so no argv of any process holds the address,
#     user or password. pg_dump reads the connection from its environment.
#   - Every container runs with --log-driver none: the daemon keeps none of their output.
#   - All output of the tools is discarded: a failing pg_dump can print production values and the
#     repository is public. The only lines printed are fixed texts and ::add-mask:: lines.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The same pinned image as POSTGRES_BASE_IMAGE in scripts/backup/constants.mjs (a test checks it).
IMAGE='postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'

mode="${1:-}"
name="${2:-}"
dir="${3:-}"

if [[ -z "$name" || -z "$dir" ]]; then
  echo "usage: prod-backup.sh dump|restore FILE DIR"
  exit 2
fi
# Only plain file names reach the containers; the name is also an argument, never interpolated.
if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "REFUSED: backup file name has unexpected characters"
  exit 2
fi

# Every PG* name this script may forward. Cleared first so nothing leaks in from the runner.
libpq_names() { node "$HERE/libpq-env.mjs" --names; }

dump() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "PREMERGE_PROD_DATABASE_URL secret is required (environment production-migration-premerge)"
    exit 1
  fi

  # Global on purpose: the EXIT trap runs after this function has returned.
  LIBPQ_FILE="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/premerge-libpq.XXXXXX")"
  trap 'rm -f "$LIBPQ_FILE"' EXIT

  if ! node "$HERE/libpq-env.mjs" --out "$LIBPQ_FILE"; then
    echo "backup not started: DATABASE_URL is not a supported connection; migration not applied"
    exit 1
  fi

  # From here on only the PG* variables describe the connection.
  unset DATABASE_URL
  local n
  while read -r n; do unset "$n"; done < <(libpq_names)
  # shellcheck source=/dev/null
  . "$LIBPQ_FILE"

  local -a env_args=()
  while read -r n; do env_args+=(-e "$n"); done < <(libpq_names)

  mkdir -p "$dir"
  docker run --rm --log-driver none "${env_args[@]}" \
    -v "$dir:/backups" "$IMAGE" \
    sh -c 'pg_dump --format=custom --no-owner --no-privileges --serializable-deferrable --file="/backups/$1"' \
    sh "$name" > /dev/null 2>&1 || { echo "backup failed; migration not applied"; exit 1; }

  test -s "$dir/$name" || { echo "backup failed; migration not applied"; exit 1; }
  echo "backup created"
}

restore() {
  test -s "$dir/$name" || { echo "backup file is missing; migration not applied"; exit 1; }

  # Stop the scratch database on every exit path, including a failed step.
  trap 'docker stop scratch > /dev/null 2>&1 || true' EXIT

  docker network create restore-check > /dev/null
  docker run -d --rm --name scratch --network restore-check --log-driver none \
    -e POSTGRES_PASSWORD=scratch -e POSTGRES_DB=restore_check "$IMAGE" > /dev/null

  local ready="" _
  for _ in $(seq 1 60); do
    if docker exec scratch pg_isready -h 127.0.0.1 -p 5432 -U postgres > /dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  [[ -n "$ready" ]] || { echo "scratch database did not start; migration not applied"; exit 1; }

  docker run --rm --network restore-check --log-driver none \
    -v "$dir:/backups" -e PGPASSWORD=scratch "$IMAGE" \
    sh -c 'pg_restore --exit-on-error --no-owner --no-privileges -h scratch -U postgres -d restore_check "/backups/$1"' \
    sh "$name" > /dev/null 2>&1 || { echo "backup restore check failed; migration not applied"; exit 1; }

  echo "backup restored into a scratch PostgreSQL 17"
  rm -f "$dir/$name"
}

case "$mode" in
  dump) dump ;;
  restore) restore ;;
  *)
    echo "usage: prod-backup.sh dump|restore FILE DIR"
    exit 2
    ;;
esac
