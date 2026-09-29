#!/bin/sh
set -eu

base=https://pos.finn3.com
secret=/srv/docker/secrets/myfin-prod/gorilla-admin.secret
test -f "$secret"
work=$(mktemp -d /tmp/myfin-prod-public.XXXXXX)
chmod 700 "$work"
trap 'rm -rf -- "$work"' EXIT
curl --fail --silent --show-error "$base/api/tenant-context" > "$work/tenant.json"
python3 - "$work/tenant.json" <<'PY'
import json,sys
tenant=json.load(open(sys.argv[1]))
assert tenant['surface']=='control' and tenant['hostname']=='pos.finn3.com'
PY
python3 - "$secret" <<'PY' |
import json,pathlib,sys
print(json.dumps({'email':'gorilla@bayamtech.com','password':pathlib.Path(sys.argv[1]).read_text().strip()}))
PY
  curl --fail --silent --show-error -c "$work/cookies" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- "$base/api/auth/sign-in/email" > "$work/login.json"
chmod 600 "$work/cookies" "$work/login.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/me" > "$work/me.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies" > "$work/companies.json"
company=$(python3 - "$work/me.json" "$work/companies.json" <<'PY'
import json,sys
me=json.load(open(sys.argv[1])); companies=json.load(open(sys.argv[2]))
assert me['role']=='super_admin' and me['authLevel']=='password'
assert isinstance(companies,list) and companies
print(companies[0]['id'])
PY
)
for resource in products stock_items; do
  curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/$resource?limit=100" > "$work/$resource.json"
done
python3 - "$work/products.json" "$work/stock_items.json" <<'PY'
import json,sys
products=json.load(open(sys.argv[1])); stock=json.load(open(sys.argv[2]))
assert isinstance(products['rows'],list) and products['rows']
assert isinstance(stock['rows'],list)
print('production_public_authenticated_smoke_passed')
PY
curl --fail --silent --show-error -b "$work/cookies" -H "Origin: $base" -H 'Content-Type: application/json' -d '{}' "$base/api/auth/sign-out" > /dev/null
