#!/bin/sh
. "$(dirname "$0")/production-common.sh"
. "$(dirname "$0")/wait-api-ready.sh"
receipt_email_enabled=false
case "${RECEIPT_EMAIL_ENABLED:-false}" in [Tt][Rr][Uu][Ee]) receipt_email_enabled=true;; esac
compose config --quiet
[ "${MYFIN_REVIEWED_PROD_DEPLOYMENT:-}" = myfin-prod ] || { echo 'Set MYFIN_REVIEWED_PROD_DEPLOYMENT=myfin-prod after deployment review' >&2; exit 1; }
. "$(dirname "$0")/check-runtime-capacity.sh"
if [ "$receipt_email_enabled" = true ]; then
  : "${MYFIN_SMTP_EGRESS_NETWORK:?reviewed SMTP-only egress network required}"
  : "${RECEIPT_SMTP_ADDRESS:?reviewed SMTP connection address required}"
  : "${RECEIPT_SMTP_TLS_SERVERNAME:?reviewed SMTP certificate hostname required}"
  : "${RECEIPT_SMTP_USERNAME:?send-only SMTP identity required}"
  : "${RECEIPT_EMAIL_FROM_ADDRESS:?approved receipt From address required}"
  : "${MYFIN_SMTP_PASSWORD_FILE:?protected SMTP password file required}"
  [ "$MYFIN_SMTP_EGRESS_NETWORK" != nexus-data ] || { echo 'Use a separate SMTP-only egress network' >&2; exit 1; }
  case "$MYFIN_SMTP_PASSWORD_FILE" in /*) ;; *) echo 'SMTP password file must be an absolute path' >&2; exit 1;; esac
  [ -r "$MYFIN_SMTP_PASSWORD_FILE" ] || { echo 'SMTP password file is not readable' >&2; exit 1; }
  docker network inspect "$MYFIN_SMTP_EGRESS_NETWORK" >/dev/null
fi
# Trust only the web container's exact project-private address for the
# nginx-overwritten public client-IP header. Discovery failure stops rollout.
compose up -d --no-build web
web_container=$(compose ps -q web)
[ -n "$web_container" ] || { echo 'Web container was not created' >&2; exit 1; }
web_app_ip=$(docker inspect --format '{{with index .NetworkSettings.Networks "myfin-prod_app"}}{{.IPAddress}}{{end}}' "$web_container")
[ -n "$web_app_ip" ] || { echo 'Web app-network address was not found' >&2; exit 1; }
PUBLIC_PROXY_ADDRESSES=$web_app_ip
export PUBLIC_PROXY_ADDRESSES
if [ "$receipt_email_enabled" = true ]; then
  compose --profile receipt-email up -d --no-build api report-worker receipt-email-worker
else
  compose --profile receipt-email rm -sf receipt-email-worker >/dev/null 2>&1 || true
  compose up -d --no-build api report-worker
fi
wait_api_ready
compose ps
