#!/bin/sh
# Runs inside the pinned tools image as root. Writes three reports for the host:
#   /work/out/source/{identities.tsv,migration.txt}    live database, read-only queries
#   /work/out/restored/{identities.tsv,migration.txt,counts.tsv}   the restored copy
# Restores /work/dump.custom into a temporary PostgreSQL cluster under /work/pgdata.
# Everything here lives under /work, which the host removes after the run.
# Any failed command stops the script with a non-zero status (set -e, ON_ERROR_STOP).
set -eu

OUT=/work/out
mkdir -p "$OUT/source" "$OUT/restored"

# Table identity: name, then each column with its type and nullability (public schema).
IDENTITY_SQL="SELECT c.table_name || E'\t' || string_agg(c.column_name || ' ' || c.udt_name || ' ' || c.is_nullable, ',' ORDER BY c.ordinal_position)
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
GROUP BY c.table_name ORDER BY c.table_name;"

# Latest applied Prisma migration.
MIGRATION_SQL="SELECT migration_name FROM _prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name DESC LIMIT 1;"

# Row counts per base table, exact (count(*), not statistics).
COUNTS_SQL="SELECT table_name || E'\t' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;"

# Source: metadata only.
psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "$IDENTITY_SQL" > "$OUT/source/identities.tsv"
psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "$MIGRATION_SQL" > "$OUT/source/migration.txt"

PGDATA=/work/pgdata
RUNDIR=/work/run
mkdir -p "$PGDATA" "$RUNDIR"
chown -R postgres:postgres "$PGDATA" "$RUNDIR"

stop_cluster() {
  su-exec postgres pg_ctl -D "$PGDATA" -m fast stop > /dev/null 2>&1 || true
}
trap stop_cluster EXIT

su-exec postgres initdb -D "$PGDATA" -U postgres --auth=trust -E UTF8 > /work/initdb.log 2>&1
su-exec postgres pg_ctl -D "$PGDATA" -w -l /work/server.log \
  -o "-k $RUNDIR -c listen_addresses=''" start > /dev/null

su-exec postgres createdb -h "$RUNDIR" -U postgres restored
# --exit-on-error: a single failed object makes the whole copy fail verification.
su-exec postgres pg_restore -h "$RUNDIR" -U postgres --no-owner --no-privileges \
  --exit-on-error -d restored /work/dump.custom

restored() {
  su-exec postgres psql -h "$RUNDIR" -U postgres -d restored -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"
}
restored "$IDENTITY_SQL" > "$OUT/restored/identities.tsv"
restored "$MIGRATION_SQL" > "$OUT/restored/migration.txt"
restored "$COUNTS_SQL" > "$OUT/restored/counts.tsv"

echo "describe: done"
