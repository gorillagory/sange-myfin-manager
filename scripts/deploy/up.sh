#!/bin/sh
. "$(dirname "$0")/common.sh"
compose config --quiet
# Caller must have reviewed exact LAN bind/port, DNS, backup and image evidence.
[ "${MYFIN_REVIEWED_DEV_DEPLOYMENT:-}" = myfin-dev ] || { echo 'Set MYFIN_REVIEWED_DEV_DEPLOYMENT=myfin-dev after deployment review' >&2; exit 1; }
compose up -d --no-build api web
compose ps
