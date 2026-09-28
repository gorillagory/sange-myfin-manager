#!/bin/sh
. "$(dirname "$0")/production-common.sh"
[ "${MYFIN_REVIEWED_PROD_PROVISION:-}" = myfin_prod ] || { echo 'Set MYFIN_REVIEWED_PROD_PROVISION=myfin_prod after provisioning review' >&2; exit 1; }
: "${MYFIN_MIGRATOR_PASSWORD_FILE:?protected production migrator secret}"
: "${MYFIN_DB_PASSWORD_FILE:?protected production runtime secret}"
: "${MYFIN_API_IMAGE:?reviewed production API image}"
if docker volume inspect myfin-prod-uploads >/dev/null 2>&1; then echo 'Production upload volume already exists; inspect it before continuing' >&2; exit 1; fi
umask 077
MYFIN_SECRET_SQL=$(mktemp "$(dirname "$MYFIN_DB_PASSWORD_FILE")/prod-role-passwords.XXXXXX")
MYFIN_SECRET_LOG=$(mktemp "$(dirname "$MYFIN_DB_PASSWORD_FILE")/prod-role-result.XXXXXX")
export MYFIN_SECRET_SQL
trap 'rm -f "$MYFIN_SECRET_SQL" "$MYFIN_SECRET_LOG"' EXIT HUP INT TERM
python3 - <<'PY'
import os,pathlib
out=[]
for role,key in [('myfin_prod_runtime','MYFIN_DB_PASSWORD_FILE'),('myfin_prod_migrator','MYFIN_MIGRATOR_PASSWORD_FILE')]:
 p=pathlib.Path(os.environ[key]);value=p.read_text().strip()
 if len(value)<32 or any(c in value for c in "\r\n\0"):raise SystemExit('Invalid protected password input')
 out.append("ALTER ROLE "+role+" PASSWORD '"+value.replace("'","''")+"';")
pathlib.Path(os.environ['MYFIN_SECRET_SQL']).write_text('\n'.join(out))
PY
docker exec -i nexus-shared-postgres psql -X -U "${MYFIN_PG_ADMIN_ROLE:-postgres}" -d postgres -v ON_ERROR_STOP=1 < "$MYFIN_REPO/db/provision-production.sql"
if ! docker exec -i nexus-shared-postgres psql -X -U "${MYFIN_PG_ADMIN_ROLE:-postgres}" -d myfin_prod -v ON_ERROR_STOP=1 < "$MYFIN_SECRET_SQL" > "$MYFIN_SECRET_LOG" 2>&1; then
 echo 'Production role password assignment failed. Inspect role state before retrying.' >&2; exit 1
fi
docker volume create --label purpose=myfin-prod myfin-prod-uploads >/dev/null
docker run --rm --network none --memory 64m --cpus 0.25 --user 0 --mount type=volume,src=myfin-prod-uploads,dst=/app/uploads --entrypoint sh "$MYFIN_API_IMAGE" -c 'chown 1000:1000 /app/uploads && chmod 700 /app/uploads'
echo 'MyFin production resources provisioned; run production migrations and explicit grants next.'
