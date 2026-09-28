#!/bin/sh
. "$(dirname "$0")/common.sh"
: "${MYFIN_SEED_PASSWORD_FILE:?protected synthetic password file}"
: "${MYFIN_SEED_EMAIL:?synthetic .test email}"
compose run --rm --no-deps -v "$MYFIN_SEED_PASSWORD_FILE:/run/secrets/seed:ro" -e NODE_ENV=development -e MYFIN_ALLOW_DEV_SEED=true -e MYFIN_SEED_PASSWORD_FILE=/run/secrets/seed -e MYFIN_SEED_EMAIL api node src/seed-cli.js
