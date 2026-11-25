#!/bin/bash
# Scheduled verified copy of the Clickmoji database (AGE-1669). Started by the launchd agent
# installed from scripts/backup/launchd, or by hand from the main checkout.
#
# The read-only database address is read from the login Keychain (generic password, service
# clickmoji-backup-readonly). It is held in one shell variable and passed only in the environment of
# the single npm process. It never appears in argv, a file, a log or a status line. security's own
# diagnostics are discarded, so a lookup failure prints only the fixed status text.
#
# Output: the copy's own status line goes to BACKUP_STATUS_FILE (tab-separated: UTC time, outcome,
# detail). A failed lookup is recorded there with the same format.
set -eu
umask 077
# Never enable shell tracing here: it would print the address.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
MAIN_CHECKOUT="$HOME/Projects/clickmoji-shop"
BACKUP_DIR="$MAIN_CHECKOUT/backups"
STATE_DIR="$HOME/Library/Logs/clickmoji-backup"
STATUS_FILE="$STATE_DIR/status.tsv"
TMP_DIR="$HOME/Library/Caches/clickmoji-backup/tmp"

mkdir -p "$STATE_DIR" "$TMP_DIR"
chmod 700 "$STATE_DIR" "$TMP_DIR"

lookup_status=0
database_url="$(security find-generic-password -s clickmoji-backup-readonly -w 2>/dev/null)" || lookup_status=$?

if [ "$lookup_status" -ne 0 ] || [ -z "$database_url" ]; then
  database_url=""
  cd "$REPO_ROOT"
  BACKUP_DIR="$BACKUP_DIR" BACKUP_STATUS_FILE="$STATUS_FILE" \
    node scripts/backup/record-scheduled-failure.mjs || true
  exit 1
fi

cd "$REPO_ROOT"
DATABASE_URL="$database_url" \
TMPDIR="$TMP_DIR" \
BACKUP_DIR="$BACKUP_DIR" \
BACKUP_STATUS_FILE="$STATUS_FILE" \
BACKUP_ENCRYPT=0 \
BACKUP_RETENTION_COUNT=2 \
  npm run db:backup:verified
