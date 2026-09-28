#!/bin/sh
set -eu
# Production commands are kept separate from the development-only helpers.
: "${MYFIN_RUNTIME_ENV:?path to reviewed protected production environment}"
case "$MYFIN_RUNTIME_ENV" in /*) ;; *) echo 'Use an absolute environment file path' >&2; exit 1;; esac
[ -f "$MYFIN_RUNTIME_ENV" ] || exit 1
set -a
. "$MYFIN_RUNTIME_ENV"
set +a
[ "${MYFIN_COMPOSE_PROJECT:-}" = myfin-prod ] || { echo 'Production Compose project required' >&2; exit 1; }
[ "${MYFIN_DB_NAME:-}" = myfin_prod ] || { echo 'Production database only' >&2; exit 1; }
[ "${MYFIN_DB_USER:-}" = myfin_prod_runtime ] || exit 1
[ "${MYFIN_UPLOAD_VOLUME:-}" = myfin-prod-uploads ] || exit 1
[ "${PUBLIC_ROOT_DOMAIN:-}" = finn3.com ] || exit 1
[ "${AUTH_ALLOWED_HOSTS:-}" = '*.finn3.com' ] || exit 1
[ "${TENANT_HOST_ENFORCEMENT:-}" = true ] || exit 1
case "${AUTH_BASE_URL:-}" in https://*.finn3.com) ;; *) echo 'Exact finn3.com HTTPS origin required' >&2; exit 1;; esac
MYFIN_REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compose() { docker compose --env-file "$MYFIN_RUNTIME_ENV" -p myfin-prod -f "$MYFIN_REPO/deploy/compose.yml" "$@"; }
