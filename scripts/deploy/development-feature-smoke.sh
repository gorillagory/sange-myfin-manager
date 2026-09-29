#!/bin/sh
set -eu

# Read-only public HTTPS check of the newly added development endpoints.
base=https://dev-pos.bayam.live
private=/srv/docker/secrets/myfin-dev
work=$(mktemp -d /tmp/myfin-dev-features.XXXXXX)
chmod 700 "$work"
trap 'rm -rf -- "$work"' EXIT
email=$(sed -n 's/^MYFIN_SEED_EMAIL=//p' "$private/runtime.env")
test -n "$email"
test -f "$private/acceptance-password"
curl --fail --silent --show-error "$base/api/tenant-context" > "$work/tenant.json"
company=$(python3 - "$work/tenant.json" <<'PY'
import json,sys
tenant=json.load(open(sys.argv[1]))
assert tenant['surface']=='tenant' and tenant['hostname']=='dev-pos.bayam.live'
print(tenant['company']['id'])
PY
)
python3 - "$email" "$private/acceptance-password" <<'PY' |
import json,pathlib,sys
print(json.dumps({'email':sys.argv[1],'password':pathlib.Path(sys.argv[2]).read_text().strip()}))
PY
  curl --fail --silent --show-error -c "$work/cookies" -H "Origin: $base" \
    -H 'Content-Type: application/json' --data-binary @- "$base/api/auth/sign-in/email" > "$work/login.json"
chmod 600 "$work/cookies" "$work/login.json"
range=$(python3 - <<'PY'
from datetime import date,timedelta
today=date.today()
print(f'from={today-timedelta(days=7)}&to={today+timedelta(days=1)}')
PY
)
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/orders/summary" > "$work/orders-summary.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/orders?view=active&limit=10" > "$work/orders.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/reports/summary?$range" > "$work/summary.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/reports/details?$range" > "$work/details.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/reports/consolidation?$range" > "$work/consolidation.json"
python3 - "$work" "$company" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); company=sys.argv[2]
def read(name): return json.loads((root/f'{name}.json').read_text())
orders=read('orders'); counts=read('orders-summary')['counts']
summary=read('summary'); details=read('details'); consolidation=read('consolidation')
assert isinstance(orders['rows'],list) and isinstance(counts['active'],int)
assert all(key in summary and key in details['totals'] for key in ('sales','tax','expenses','cashFlow'))
assert len(consolidation['companies'])==1 and consolidation['companies'][0]['id']==company
print('development_public_feature_smoke_passed')
PY
curl --fail --silent --show-error -b "$work/cookies" -H "Origin: $base" \
  -H 'Content-Type: application/json' -d '{}' "$base/api/auth/sign-out" > /dev/null
