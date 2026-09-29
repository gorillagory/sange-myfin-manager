#!/bin/sh
set -eu

# Read-only public HTTPS acceptance for Orders and financial reporting. Run on
# nexus-docker after the production web/API pair is healthy.
base=https://pos.finn3.com
secret=/srv/docker/secrets/myfin-prod/gorilla-admin.secret
test -f "$secret"
work=$(mktemp -d /tmp/myfin-prod-features.XXXXXX)
chmod 700 "$work"
trap 'rm -rf -- "$work"' EXIT

python3 - "$secret" <<'PY' |
import json,pathlib,sys
print(json.dumps({'email':'gorilla@bayamtech.com','password':pathlib.Path(sys.argv[1]).read_text().strip()}))
PY
  curl --fail --silent --show-error -c "$work/cookies" -H "Origin: $base" \
    -H 'Content-Type: application/json' --data-binary @- "$base/api/auth/sign-in/email" > "$work/login.json"
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
range=$(python3 - <<'PY'
from datetime import date,timedelta
today=date.today()
print(f'from={today-timedelta(days=7)}&to={today+timedelta(days=1)}')
PY
)
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/orders/summary" > "$work/orders-summary.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/orders?view=active&limit=10" > "$work/orders.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/reports/details?$range" > "$work/details.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/reports/consolidation?$range" > "$work/consolidation.json"
python3 - "$work/orders-summary.json" "$work/orders.json" "$work/details.json" "$work/consolidation.json" "$company" <<'PY'
import json,sys
summary,orders,details,consolidation=[json.load(open(path)) for path in sys.argv[1:5]]
company=sys.argv[5]
assert all(isinstance(summary['counts'][key],int) for key in ('pending','preparing','ready','completed','active'))
assert isinstance(orders['rows'],list) and isinstance(orders['counts'],dict)
assert all(key in details['totals'] for key in ('sales','tax','expenses','cashFlow'))
assert isinstance(details['sales'],list) and isinstance(details['expenses'],list)
assert any(row['id']==company for row in consolidation['companies'])
print('production_public_feature_smoke_passed')
PY
curl --fail --silent --show-error -b "$work/cookies" -H "Origin: $base" \
  -H 'Content-Type: application/json' -d '{}' "$base/api/auth/sign-out" > /dev/null
