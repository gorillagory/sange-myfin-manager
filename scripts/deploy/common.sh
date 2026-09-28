#!/bin/sh
set -eu
# Intentionally fixed deployment scope. Disposable tests use their own harness.
: "${MYFIN_RUNTIME_ENV:?path to reviewed protected deployment environment}"
case "$MYFIN_RUNTIME_ENV" in /*) ;; *) echo 'Use an absolute environment file path' >&2; exit 1;; esac
[ -f "$MYFIN_RUNTIME_ENV" ] || exit 1
set -a
. "$MYFIN_RUNTIME_ENV"
set +a
[ "${MYFIN_DB_NAME:-myfin_dev}" = myfin_dev ] || { echo 'Development database only' >&2; exit 1; }
[ "${MYFIN_DB_USER:-myfin_dev_runtime}" = myfin_dev_runtime ] || exit 1
[ "${MYFIN_UPLOAD_VOLUME:-}" = myfin-dev-uploads ] || exit 1
case "${AUTH_BASE_URL:-}" in https://*) ;; *) echo 'Exact HTTPS origin required' >&2; exit 1;; esac
MYFIN_REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compose() { docker compose --env-file "$MYFIN_RUNTIME_ENV" -p myfin-dev -f "$MYFIN_REPO/deploy/compose.yml" "$@"; }
