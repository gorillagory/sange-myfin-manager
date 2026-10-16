#!/bin/sh
. "$(dirname "$0")/common.sh"
receipt_email_enabled=false
case "${RECEIPT_EMAIL_ENABLED:-false}" in [Tt][Rr][Uu][Ee]) receipt_email_enabled=true;; esac
: "${MYFIN_BACKUP_DIR:?new absolute protected backup directory}"
: "${MYFIN_MIGRATOR_PASSWORD_FILE:?protected migrator password file}"
case "$MYFIN_BACKUP_DIR" in /*) ;; *) exit 1;; esac
case "$MYFIN_MIGRATOR_PASSWORD_FILE" in /*) ;; *) echo 'Use an absolute migrator password file path' >&2; exit 1;; esac
[ -f "$MYFIN_MIGRATOR_PASSWORD_FILE" ] || { echo 'Migrator password file is missing' >&2; exit 1; }
[ ! -e "$MYFIN_BACKUP_DIR" ] || { echo 'Backup destination must be new' >&2; exit 1; }
umask 077
mkdir -m 700 "$MYFIN_BACKUP_DIR"
writer_services='report-worker api'
if [ "$receipt_email_enabled" = true ]; then writer_services="receipt-email-worker $writer_services"; fi
compose --profile receipt-email stop $writer_services
trap 'compose --profile receipt-email start $writer_services' EXIT HUP INT TERM
# Quiescent API: PostgreSQL and private files describe the same application state.
docker run --rm --network nexus-data --memory 256m --cpus 0.5 --mount "type=bind,src=$MYFIN_MIGRATOR_PASSWORD_FILE,dst=/run/password,readonly" --mount "type=bind,src=$MYFIN_BACKUP_DIR,dst=/backup" --entrypoint sh postgres:16-bookworm -c 'export PGPASSWORD="$(cat /run/password)"; exec pg_dump -h nexus-shared-postgres -U myfin_dev_migrator -d myfin_dev --role=myfin_dev_owner --format=custom --no-owner --no-acl --file=/backup/myfin_dev.dump'
docker run --rm --network none --memory 128m --cpus 0.5 --mount type=volume,src=myfin-dev-uploads,dst=/uploads,readonly --mount "type=bind,src=$MYFIN_BACKUP_DIR,dst=/backup" --entrypoint sh postgres:16-bookworm -c 'tar -cf /backup/uploads.tar -C /uploads .'
(cd "$MYFIN_BACKUP_DIR" && sha256sum myfin_dev.dump uploads.tar > SHA256SUMS)
chmod 600 "$MYFIN_BACKUP_DIR"/*
echo 'Quiescent development backup saved. Verify restore and off-host retention separately.'
