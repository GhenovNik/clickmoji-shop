#!/bin/sh
# Runs inside the pinned tools image as root. The host forwards DATABASE_URL and the libpq
# variables (PGHOST, PGDATABASE, PGUSER, PGPASSWORD, ...) by name with `-e NAME`. The URL is
# dropped first: the libpq variables describe the same connection, and pg_dump takes no
# address on its command line. Writes the custom-format dump that verify.sh and encrypt
# read; the host removes the work directory after the run.
set -eu

unset DATABASE_URL

WORK=${BACKUP_WORK:-/work}

pg_dump --format=custom --no-owner --no-privileges --serializable-deferrable \
  --file="$WORK/dump.custom"

echo "dump: done"
