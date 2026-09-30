#!/bin/sh
. "$(dirname "$0")/production-common.sh"
compose config --quiet
[ "${MYFIN_REVIEWED_PROD_DEPLOYMENT:-}" = myfin-prod ] || { echo 'Set MYFIN_REVIEWED_PROD_DEPLOYMENT=myfin-prod after deployment review' >&2; exit 1; }
# Trust only the web container's exact project-private address for the
# nginx-overwritten public client-IP header. Discovery failure stops rollout.
compose up -d --no-build web
web_container=$(compose ps -q web)
[ -n "$web_container" ] || { echo 'Web container was not created' >&2; exit 1; }
web_app_ip=$(docker inspect --format '{{with index .NetworkSettings.Networks "myfin-prod_app"}}{{.IPAddress}}{{end}}' "$web_container")
[ -n "$web_app_ip" ] || { echo 'Web app-network address was not found' >&2; exit 1; }
PUBLIC_PROXY_ADDRESSES=$web_app_ip
export PUBLIC_PROXY_ADDRESSES
compose up -d --no-build api
compose ps
