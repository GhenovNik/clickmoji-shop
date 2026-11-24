#!/bin/sh
# Runs inside the pinned tools image as root. The source connection arrives in libpq
# variables (PGHOST, PGDATABASE, PGUSER, PGPASSWORD, ...) set by the host with `-e NAME`,
# so pg_dump takes no address on its command line. Writes the custom-format dump that
# verify.sh and encrypt read; the host removes the work directory after the run.
set -eu

WORK=${BACKUP_WORK:-/work}

pg_dump --format=custom --no-owner --no-privileges --serializable-deferrable \
  --file="$WORK/dump.custom"

echo "dump: done"
