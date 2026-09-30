#!/bin/sh
. "$(dirname "$0")/common.sh"
compose config --quiet
# Caller must have reviewed exact LAN bind/port, DNS, backup and image evidence.
[ "${MYFIN_REVIEWED_DEV_DEPLOYMENT:-}" = myfin-dev ] || { echo 'Set MYFIN_REVIEWED_DEV_DEPLOYMENT=myfin-dev after deployment review' >&2; exit 1; }
# Start the sole ingress peer first, then pin the API's trusted public-rate-limit
# proxy to that container's current address on the project-private app network.
# If discovery fails, do not start an API that might trust an unintended peer.
compose up -d --no-build web
web_container=$(compose ps -q web)
[ -n "$web_container" ] || { echo 'Web container was not created' >&2; exit 1; }
web_app_ip=$(docker inspect --format '{{with index .NetworkSettings.Networks "myfin-dev_app"}}{{.IPAddress}}{{end}}' "$web_container")
[ -n "$web_app_ip" ] || { echo 'Web app-network address was not found' >&2; exit 1; }
PUBLIC_PROXY_ADDRESSES=$web_app_ip
export PUBLIC_PROXY_ADDRESSES
compose up -d --no-build api
compose ps
