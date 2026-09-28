#!/bin/sh
. "$(dirname "$0")/common.sh"
: "${MYFIN_BACKUP_DIR:?new absolute protected backup directory}"
case "$MYFIN_BACKUP_DIR" in /*) ;; *) exit 1;; esac
[ ! -e "$MYFIN_BACKUP_DIR" ] || { echo 'Backup destination must be new' >&2; exit 1; }
umask 077
mkdir -m 700 "$MYFIN_BACKUP_DIR"
compose stop api
trap 'compose start api' EXIT HUP INT TERM
# Quiescent API: PostgreSQL and private files describe the same application state.
docker run --rm --network nexus-data --memory 256m --cpus 0.5 --mount "type=bind,src=$MYFIN_DB_PASSWORD_FILE,dst=/run/password,readonly" --mount "type=bind,src=$MYFIN_BACKUP_DIR,dst=/backup" --entrypoint sh postgres:16-bookworm -c 'export PGPASSWORD="$(cat /run/password)"; exec pg_dump -h nexus-shared-postgres -U myfin_dev_runtime -d myfin_dev --format=custom --no-owner --no-acl --file=/backup/myfin_dev.dump'
docker run --rm --network none --memory 128m --cpus 0.5 --mount type=volume,src=myfin-dev-uploads,dst=/uploads,readonly --mount "type=bind,src=$MYFIN_BACKUP_DIR,dst=/backup" --entrypoint sh postgres:16-bookworm -c 'tar -cf /backup/uploads.tar -C /uploads .'
(cd "$MYFIN_BACKUP_DIR" && sha256sum myfin_dev.dump uploads.tar > SHA256SUMS)
chmod 600 "$MYFIN_BACKUP_DIR"/*
echo 'Quiescent development backup saved. Verify restore and off-host retention separately.'
