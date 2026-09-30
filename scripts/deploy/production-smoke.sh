#!/bin/sh
. "$(dirname "$0")/production-common.sh"
MYFIN_ORIGIN="http://$MYFIN_WEB_BIND_IP:$MYFIN_WEB_PORT"
MYFIN_HOST=${AUTH_CONTROL_HOSTS%%,*}
[ -n "$MYFIN_HOST" ] || { echo 'Production control host required' >&2; exit 1; }
curl --fail --silent --show-error -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/healthz"
curl --fail --silent --show-error -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/api/health/live"
curl --fail --silent --show-error -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/api/health/ready"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/api/me")" = 401 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $MYFIN_HOST" "$MYFIN_ORIGIN/api/public/storefront")" = 404 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: $MYFIN_HOST" -H "Origin: https://$MYFIN_HOST" -H 'Content-Type: application/json' -d '{}' "$MYFIN_ORIGIN/api/auth/sign-in/email")" = 400 ]
if [ -n "${MYFIN_STOREFRONT_HOST:-}" ]; then
  case "$MYFIN_STOREFRONT_HOST" in order-*.*) ;; *) echo 'Exact order-* storefront host required' >&2; exit 1;; esac
  storefront_context=$(curl --fail --silent --show-error -H "Host: $MYFIN_STOREFRONT_HOST" "$MYFIN_ORIGIN/api/tenant-context")
  printf '%s' "$storefront_context" | python3 -c 'import json,sys; assert json.load(sys.stdin)["surface"] == "storefront"'
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $MYFIN_STOREFRONT_HOST" "$MYFIN_ORIGIN/api/me")" = 404 ]
fi
compose ps
echo 'Unauthenticated production smoke passed. Complete public HTTPS acceptance before traffic cutover.'
