#!/bin/sh
set -eu

# Run on nexus-docker. Stop only the production API so database and uploads
# describe the same instant; always restart it if a backup step fails.
runtime=/srv/docker/secrets/myfin-prod/runtime.env
repo=/srv/docker/apps/sange-myfin-manager
test -f "$runtime"
set -a
. "$runtime"
set +a
receipt_email_enabled=false
case "${RECEIPT_EMAIL_ENABLED:-false}" in [Tt][Rr][Uu][Ee]) receipt_email_enabled=true;; esac
test "${MYFIN_COMPOSE_PROJECT:-}" = myfin-prod
test "${MYFIN_DB_NAME:-}" = myfin_prod
test "${MYFIN_DB_USER:-}" = myfin_prod_runtime
test "${MYFIN_UPLOAD_VOLUME:-}" = myfin-prod-uploads
: "${MYFIN_MIGRATOR_PASSWORD_FILE:?protected production migrator password file}"
case "$MYFIN_MIGRATOR_PASSWORD_FILE" in /*) ;; *) echo 'Use an absolute migrator password file path' >&2; exit 1;; esac
test -f "$MYFIN_MIGRATOR_PASSWORD_FILE"
test -f "$repo/deploy/compose.yml"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/srv/docker/backups/myfin-prod/pre-operations-$stamp"
umask 077
mkdir -m 700 "$backup"
compose() { docker compose --env-file "$runtime" -p myfin-prod -f "$repo/deploy/compose.yml" "$@"; }
writer_services='report-worker api'
if [ "$receipt_email_enabled" = true ]; then writer_services="receipt-email-worker $writer_services"; fi
restart=0
restore_service() {
  if [ "$restart" = 1 ]; then compose --profile receipt-email start $writer_services >&2; fi
}
trap restore_service EXIT HUP INT TERM
restart=1
compose --profile receipt-email stop $writer_services

docker run --rm --network nexus-data --memory 256m --cpus 0.5 \
  --mount "type=bind,src=$MYFIN_MIGRATOR_PASSWORD_FILE,dst=/run/password,readonly" \
  --mount "type=bind,src=$backup,dst=/backup" \
  --entrypoint sh postgres:16-bookworm -c \
  'export PGPASSWORD="$(cat /run/password)"; exec pg_dump -h nexus-shared-postgres -U myfin_prod_migrator -d myfin_prod --role=myfin_prod_owner --format=custom --no-owner --no-acl --file=/backup/database.dump'
docker run --rm --network none --memory 128m --cpus 0.5 \
  --mount type=volume,src=myfin-prod-uploads,dst=/uploads,readonly \
  --mount "type=bind,src=$backup,dst=/backup" \
  --entrypoint sh postgres:16-bookworm -c \
  'tar -czf /backup/uploads.tar.gz -C /uploads .'
(cd "$backup" && sha256sum database.dump uploads.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS)
chmod 600 "$backup"/*
compose --profile receipt-email start $writer_services
restart=0
echo "production_backup=$backup"
