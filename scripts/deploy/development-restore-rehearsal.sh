#!/bin/sh
set -eu

# A disposable database proves the backup can be restored without touching
# myfin_dev or another application database.
backup=${1:?provide reviewed development backup directory}
case "$backup" in /srv/docker/backups/myfin-dev/*) ;; *) exit 1;; esac
test -f "$backup/myfin_dev.dump"
test -f "$backup/uploads.tar"
(cd "$backup" && sha256sum -c SHA256SUMS)
tar -tf "$backup/uploads.tar" >/dev/null

database=myfin_dev_restore_$(date -u +%Y%m%d%H%M%S)
docker exec nexus-shared-postgres createdb -U platform "$database"
cleanup() { docker exec nexus-shared-postgres dropdb -U platform --if-exists "$database"; }
trap cleanup EXIT HUP INT TERM
docker exec -i nexus-shared-postgres pg_restore -U platform -d "$database" \
  --no-owner --no-acl --exit-on-error < "$backup/myfin_dev.dump"
docker exec nexus-shared-postgres psql -X -U platform -d "$database" -Atc \
  'SELECT (SELECT count(*) FROM myfin.schema_migrations),
          (SELECT count(*) FROM myfin.companies),
          (SELECT count(*) FROM myfin.products),
          (SELECT count(*) FROM myfin.transactions),
          (SELECT count(*) FROM myfin.expenses);'
echo development_restore_rehearsal_passed
