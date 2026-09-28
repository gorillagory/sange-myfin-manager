#!/bin/sh
. "$(dirname "$0")/common.sh"
MYFIN_ORIGIN="http://$MYFIN_WEB_BIND_IP:$MYFIN_WEB_PORT"
MYFIN_HOST=${AUTH_BASE_URL#https://}
MYFIN_HOST=${MYFIN_HOST%%/*}
[ -n "$MYFIN_HOST" ] || { echo 'Development hostname required' >&2; exit 1; }
curl --fail --silent --show-error -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/healthz"
curl --fail --silent --show-error -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/api/health/live"
curl --fail --silent --show-error -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/api/health/ready"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/api/me")" = 401 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: $MYFIN_HOST" -H "Origin: https://$MYFIN_HOST" -H 'Content-Type: application/json' -d '{}' "$MYFIN_ORIGIN/api/auth/sign-in/email")" = 400 ]
compose ps
echo 'Unauthenticated development smoke passed. Complete HTTPS login/POS/offline/file/browser acceptance next.'
