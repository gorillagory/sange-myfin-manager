#!/bin/sh
. "$(dirname "$0")/common.sh"
. "$(dirname "$0")/wait-api-ready.sh"
receipt_email_enabled=false
case "${RECEIPT_EMAIL_ENABLED:-false}" in [Tt][Rr][Uu][Ee]) receipt_email_enabled=true;; esac
compose config --quiet
# Caller must have reviewed exact LAN bind/port, DNS, backup and image evidence.
[ "${MYFIN_REVIEWED_DEV_DEPLOYMENT:-}" = myfin-dev ] || { echo 'Set MYFIN_REVIEWED_DEV_DEPLOYMENT=myfin-dev after deployment review' >&2; exit 1; }
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
if [ "$receipt_email_enabled" = true ]; then
  compose --profile receipt-email up -d --no-build api report-worker receipt-email-worker
else
  compose --profile receipt-email rm -sf receipt-email-worker >/dev/null 2>&1 || true
  compose up -d --no-build api report-worker
fi
wait_api_ready
compose ps
