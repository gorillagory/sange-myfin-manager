#!/bin/bash
set -euo pipefail
# Read-only public acceptance for the exact development host. Run on nexus-docker.
base=https://dev-pos.bayam.live
private=/srv/docker/secrets/myfin-dev
work=$(mktemp -d /tmp/myfin-operations-smoke.XXXXXX)
chmod 700 "$work"
trap 'rm -rf -- "$work"' EXIT
test -f "$private/acceptance-password"
email=$(sed -n 's/^MYFIN_SEED_EMAIL=//p' "$private/runtime.env")
test -n "$email"
curl --fail --silent --show-error "$base/api/tenant-context" > "$work/tenant.json"
company=$(python3 - "$work/tenant.json" <<'PY'
import json,sys
tenant=json.load(open(sys.argv[1]))
assert tenant['surface']=='tenant'
assert tenant['hostname']=='dev-pos.bayam.live' and tenant['canonical'] is True
assert tenant['workspace']['slug']=='bfsb' and tenant['company']['slug']=='bali'
print(tenant['company']['id'])
PY
)
python3 - "$email" "$private/acceptance-password" <<'PY' |
import json,pathlib,sys
print(json.dumps({'email':sys.argv[1],'password':pathlib.Path(sys.argv[2]).read_text().strip()}))
PY
  curl --fail --silent --show-error -c "$work/cookies" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- "$base/api/auth/sign-in/email" > "$work/login.json"
chmod 600 "$work/cookies" "$work/login.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/me" > "$work/me.json"
for resource in products transactions clients expenses stock_items stock_ledger; do
  curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/$resource?limit=1" > "$work/$resource.json"
done
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/receipt-reviews" > "$work/receipt-reviews.json"
python3 - "$work" "$company" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); company=sys.argv[2]
me=json.loads((root/'me.json').read_text())
assert me['company_id']==company and me['role']=='super_admin'
for resource in ('products','transactions','clients','expenses','stock_items','stock_ledger'):
    payload=json.loads((root/f'{resource}.json').read_text())
    assert isinstance(payload['rows'],list),resource
    assert payload.get('next') is None or isinstance(payload['next'],str),resource
reviews=json.loads((root/'receipt-reviews.json').read_text())
assert isinstance(reviews,list)
print('public_operations_read_acceptance_passed')
PY
curl --fail --silent --show-error -b "$work/cookies" -H "Origin: $base" -H 'Content-Type: application/json' -d '{}' "$base/api/auth/sign-out" > /dev/null
