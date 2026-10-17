#!/bin/sh
set -eu

# Every long-lived process has its own node-postgres pool, but all workers in
# one environment share a PostgreSQL login. Refuse rollout when that role
# cannot admit the configured worst-case pool total.
: "${MYFIN_DB_USER:?runtime database role required}"
case "$MYFIN_DB_USER" in
  myfin_dev_runtime|myfin_prod_runtime) ;;
  *) echo 'Unexpected MyFin runtime database role' >&2; exit 1;;
esac

validate_pool_size() {
  pool_name=$1
  pool_size=$2
  case "$pool_size" in ''|*[!0-9]*) echo "$pool_name must be an integer from 1 to 20" >&2; exit 1;; esac
  [ "$pool_size" -ge 1 ] && [ "$pool_size" -le 20 ] || {
    echo "$pool_name must be an integer from 1 to 20" >&2
    exit 1
  }
}

api_pool=${MYFIN_DB_POOL_MAX:-5}
report_pool=${MYFIN_REPORT_DB_POOL_MAX:-2}
receipt_pool=${MYFIN_RECEIPT_EMAIL_DB_POOL_MAX:-2}
validate_pool_size MYFIN_DB_POOL_MAX "$api_pool"
validate_pool_size MYFIN_REPORT_DB_POOL_MAX "$report_pool"

required_connections=$((api_pool + report_pool))
case "${RECEIPT_EMAIL_ENABLED:-false}" in
  [Tt][Rr][Uu][Ee])
    validate_pool_size MYFIN_RECEIPT_EMAIL_DB_POOL_MAX "$receipt_pool"
    required_connections=$((required_connections + receipt_pool))
    ;;
esac

role_limit=$(docker exec nexus-shared-postgres psql -X --no-psqlrc \
  -U "${MYFIN_PG_ADMIN_ROLE:-postgres}" -d postgres -Atq -v ON_ERROR_STOP=1 \
  -c "SELECT rolconnlimit FROM pg_catalog.pg_roles WHERE rolname = '$MYFIN_DB_USER'")
[ "$role_limit" != -1 ] || {
  echo 'MyFin runtime role must have a bounded PostgreSQL connection limit' >&2
  exit 1
}
case "$role_limit" in
  ''|*[!0-9]*) echo 'Could not read a numeric runtime role connection limit' >&2; exit 1;;
esac
[ "$role_limit" -ge "$required_connections" ] || {
  echo "MyFin runtime role connection limit $role_limit is below configured pool capacity $required_connections" >&2
  exit 1
}

echo "MyFin runtime connection capacity verified: role limit $role_limit, configured pools $required_connections."
