#!/bin/sh
. "$(dirname "$0")/common.sh"
[ "${MYFIN_REVIEWED_DEV_GENESIS:-}" = myfin_dev ] || { echo 'Set MYFIN_REVIEWED_DEV_GENESIS=myfin_dev after reviewing the initial administrator' >&2; exit 1; }
: "${MYFIN_MIGRATOR_PASSWORD_FILE:?protected migrator password file}"
: "${MYFIN_GENESIS_PASSWORD_FILE:?protected initial SuperAdmin password file}"
: "${MYFIN_GENESIS_EMAIL:?initial SuperAdmin email}"
: "${MYFIN_GENESIS_DISPLAY_NAME:?initial SuperAdmin display name}"
case "$MYFIN_GENESIS_PASSWORD_FILE" in /*) ;; *) echo 'Use an absolute genesis password file path' >&2; exit 1;; esac
[ -f "$MYFIN_GENESIS_PASSWORD_FILE" ] || exit 1
MYFIN_DB_PASSWORD_FILE="$MYFIN_MIGRATOR_PASSWORD_FILE" compose run --rm --no-deps \
  -e PGUSER=myfin_dev_migrator \
  -e GENESIS_OWNER=myfin_dev_owner \
  -e MYFIN_ALLOW_GENESIS=myfin_dev \
  -e MYFIN_GENESIS_EMAIL \
  -e MYFIN_GENESIS_DISPLAY_NAME \
  -e MYFIN_GENESIS_PASSWORD_FILE=/run/secrets/genesis_password \
  -v "$MYFIN_GENESIS_PASSWORD_FILE:/run/secrets/genesis_password:ro" \
  api node src/genesis-cli.js
