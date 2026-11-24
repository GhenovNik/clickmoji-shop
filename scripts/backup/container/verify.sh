#!/bin/sh
# Runs inside the pinned tools image as root. Writes reports for the host:
#   $WORK/out/source/{identities.tsv,migration.txt}               live database, metadata only
#   $WORK/out/restored/{identities.tsv,migration.txt,counts.tsv}  the restored copy
# Restores $WORK/dump.custom into a temporary PostgreSQL 17 cluster. The cluster lives in
# /tmp/pgcluster inside this container, never in the bind-mounted work directory, so the
# server (which runs as the postgres user) needs no access to host files and no plaintext
# cluster is left on the host. Clients run as root and reach the server through its socket.
# Any failed command stops the script with a non-zero status (set -e, ON_ERROR_STOP).
set -eu

WORK=${BACKUP_WORK:-/work}
OUT="$WORK/out"
CLUSTER=${BACKUP_CLUSTER:-/tmp/pgcluster}
PGDATA="$CLUSTER/data"
RUNDIR="$CLUSTER/run"
LOGDIR="$CLUSTER/log"
PORT=5432

command -v su-exec > /dev/null 2>&1 || { echo "verify: su-exec is missing from the image" >&2; exit 1; }

mkdir -p "$OUT/source" "$OUT/restored"

# Application tables in every user schema, keyed by schema-qualified name (%I quotes as
# needed). pg_catalog reports columns whatever the connecting role may read, so a role with
# partial privileges cannot shrink the list. Partitioned tables and their partitions both
# appear; a table with no columns cannot be compared and is reported as missing.
TABLE_FILTER="c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'"

IDENTITY_SQL="SELECT format('%I.%I', n.nspname, c.relname) || E'\t' || string_agg(format('%I %s %s', a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE 'NULL' END), ',' ORDER BY a.attnum)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE $TABLE_FILTER
GROUP BY n.nspname, c.relname
ORDER BY 1;"

# Exact row counts (count(*), not statistics), keyed the same way as the identities.
COUNTS_SQL="SELECT format('%I.%I', n.nspname, c.relname) || E'\t' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE $TABLE_FILTER
ORDER BY 1;"

# Latest applied Prisma migration. Prisma counts a migration as applied when it finished
# and was not rolled back; the table is the one Prisma uses in the public schema.
MIGRATION_SQL="SELECT migration_name FROM public._prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name DESC LIMIT 1;"

# Source: metadata only, over the network, through the libpq variables. Nothing is
# written to the source. The password is dropped from the environment before the local
# cluster is used.
psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" > "$OUT/source/identities.tsv"
psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$MIGRATION_SQL" > "$OUT/source/migration.txt"
unset PGPASSWORD

mkdir -p "$PGDATA" "$RUNDIR" "$LOGDIR"
chown -R postgres:postgres "$CLUSTER"

stop_cluster() {
  su-exec postgres pg_ctl -D "$PGDATA" -m fast stop > /dev/null 2>&1 || true
}
trap stop_cluster EXIT

su-exec postgres initdb -D "$PGDATA" -U postgres --auth=trust -E UTF8 > "$LOGDIR/initdb.log" 2>&1
su-exec postgres pg_ctl -D "$PGDATA" -w -l "$LOGDIR/server.log" \
  -o "-k $RUNDIR -p $PORT -c listen_addresses=''" start > /dev/null

# Local clients run as root and address the socket explicitly, so the source's PG* values
# in the environment cannot redirect them.
LOCAL="-h $RUNDIR -p $PORT -U postgres"

createdb $LOCAL restored
# --exit-on-error: a single failed object makes the whole copy fail verification.
pg_restore $LOCAL --no-owner --no-privileges --exit-on-error -d restored "$WORK/dump.custom"

restored() {
  psql $LOCAL -d restored -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"
}
restored "$IDENTITY_SQL" > "$OUT/restored/identities.tsv"
restored "$MIGRATION_SQL" > "$OUT/restored/migration.txt"
restored "$COUNTS_SQL" > "$OUT/restored/counts.tsv"

echo "describe: done"
