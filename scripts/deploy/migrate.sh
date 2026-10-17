#!/bin/sh
. "$(dirname "$0")/common.sh"
: "${MYFIN_MIGRATOR_PASSWORD_FILE:?protected migrator password file}"
# Migration 0043 changes the expense write contract. Stop every existing writer
# before applying it; a failed migration intentionally leaves writers stopped.
compose --profile receipt-email stop receipt-email-worker report-worker api
MYFIN_DB_PASSWORD_FILE="$MYFIN_MIGRATOR_PASSWORD_FILE" compose run --rm --no-deps -e PGUSER=myfin_dev_migrator -e MIGRATION_OWNER=myfin_dev_owner api node src/migrate-cli.js
# Apply only explicit MyFin grants, never platform defaults.
docker exec -i nexus-shared-postgres psql -X -U "${MYFIN_PG_ADMIN_ROLE:-postgres}" -d myfin_dev -v ON_ERROR_STOP=1 < "$MYFIN_REPO/db/grant-development-runtime.sql"
