#!/bin/sh
. "$(dirname "$0")/common.sh"
[ "${MYFIN_REVIEWED_EMPTY_DEV_RESTORE:-}" = myfin_dev ] || { echo 'Explicit empty development restore review required' >&2; exit 1; }
: "${MYFIN_BACKUP_DIR:?protected matching backup pair}"
: "${MYFIN_MIGRATOR_PASSWORD_FILE:?protected migrator secret}"
(cd "$MYFIN_BACKUP_DIR" && sha256sum -c SHA256SUMS)
compose stop api
# Never drop an existing database or overwrite nonempty uploads.
MYFIN_TABLES=$(docker run --rm --network nexus-data --memory 128m --cpus 0.5 --mount "type=bind,src=$MYFIN_MIGRATOR_PASSWORD_FILE,dst=/run/password,readonly" --entrypoint sh postgres:16-bookworm -c 'export PGPASSWORD="$(cat /run/password)"; psql -X -h nexus-shared-postgres -U myfin_dev_migrator -d myfin_dev -Atc "SELECT count(*) FROM pg_tables WHERE schemaname= '\''myfin'\''"')
[ "$MYFIN_TABLES" = 0 ] || { echo 'Refusing restore over existing MyFin tables; API remains stopped' >&2; exit 1; }
docker run --rm --network none --memory 128m --cpus 0.5 --mount type=volume,src=myfin-dev-uploads,dst=/uploads --mount "type=bind,src=$MYFIN_BACKUP_DIR,dst=/backup,readonly" --entrypoint sh postgres:16-bookworm -c 'test -z "$(ls -A /uploads)" && tar --no-same-owner -xf /backup/uploads.tar -C /uploads && chown -R 1000:1000 /uploads && chmod 700 /uploads'
docker run --rm --network nexus-data --memory 256m --cpus 0.5 --mount "type=bind,src=$MYFIN_MIGRATOR_PASSWORD_FILE,dst=/run/password,readonly" --mount "type=bind,src=$MYFIN_BACKUP_DIR,dst=/backup,readonly" --entrypoint sh postgres:16-bookworm -c 'export PGPASSWORD="$(cat /run/password)"; pg_restore -l /backup/myfin_dev.dump | sed "/ SCHEMA - myfin /d" > /tmp/myfin-restore.list; exec pg_restore --use-list=/tmp/myfin-restore.list -h nexus-shared-postgres -U myfin_dev_migrator -d myfin_dev --role=myfin_dev_owner --single-transaction --no-owner --no-acl /backup/myfin_dev.dump'
docker exec -i nexus-shared-postgres psql -X -U "${MYFIN_PG_ADMIN_ROLE:-postgres}" -d myfin_dev -v ON_ERROR_STOP=1 < "$MYFIN_REPO/db/grant-development-runtime.sql"
echo 'Restore finished; API remains stopped for migration/checksum and file verification before reviewed up.'
