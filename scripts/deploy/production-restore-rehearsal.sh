#!/bin/sh
set -eu

# Run on nexus-docker against a newly created disposable database only.
backup=${1:?provide a reviewed production backup directory}
case "$backup" in /srv/docker/backups/myfin-prod/*) ;; *) exit 1;; esac
test -f "$backup/database.dump"
test -f "$backup/uploads.tar.gz"
(cd "$backup" && sha256sum -c SHA256SUMS)

database=myfin_prod_restore_$(date -u +%Y%m%d%H%M%S)
docker exec nexus-shared-postgres createdb -U platform "$database"
cleanup() { docker exec nexus-shared-postgres dropdb -U platform --if-exists "$database"; }
trap cleanup EXIT HUP INT TERM
docker exec -i nexus-shared-postgres pg_restore -U platform -d "$database" \
  --no-owner --no-acl --exit-on-error < "$backup/database.dump"
docker exec nexus-shared-postgres psql -X -U platform -d "$database" -Atc \
  'SELECT (SELECT count(*) FROM myfin.schema_migrations),
          (SELECT count(*) FROM myfin.companies),
          (SELECT count(*) FROM myfin.products),
          (SELECT count(*) FROM myfin.transactions),
          (SELECT count(*) FROM myfin.expenses);'
echo production_restore_rehearsal_passed
