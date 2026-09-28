#!/bin/sh
. "$(dirname "$0")/production-common.sh"
compose config --quiet
[ "${MYFIN_REVIEWED_PROD_DEPLOYMENT:-}" = myfin-prod ] || { echo 'Set MYFIN_REVIEWED_PROD_DEPLOYMENT=myfin-prod after deployment review' >&2; exit 1; }
compose up -d --no-build api web
compose ps
