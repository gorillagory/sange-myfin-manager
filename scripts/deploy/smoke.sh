#!/bin/sh
. "$(dirname "$0")/common.sh"
MYFIN_ORIGIN="http://$MYFIN_WEB_BIND_IP:$MYFIN_WEB_PORT"
curl --fail --silent --show-error "$MYFIN_ORIGIN/healthz"
curl --fail --silent --show-error "$MYFIN_ORIGIN/api/health/live"
curl --fail --silent --show-error "$MYFIN_ORIGIN/api/health/ready"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$MYFIN_ORIGIN/api/me")" = 401 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$MYFIN_ORIGIN/api/auth/sign-in/email" -H 'Content-Type: application/json' -d '{}')" = 403 ]
compose ps
echo 'Unauthenticated development smoke passed. Complete HTTPS login/POS/offline/file/browser acceptance next.'
