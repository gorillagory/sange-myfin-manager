#!/bin/sh
set -eu

# Read-only reconciliation of the protected Snidect migration through the
# public tenant route. Run on nexus-docker after the production API is healthy.
base=https://snidect-technologies-main.finn3.com
secret=/srv/docker/secrets/myfin-prod/gorilla-admin.secret
test -f "$secret"
work=$(mktemp -d /tmp/myfin-prod-accounting.XXXXXX)
chmod 700 "$work"
trap 'rm -rf -- "$work"' EXIT

curl --fail --silent --show-error "$base/api/tenant-context" > "$work/tenant.json"
company=$(python3 - "$work/tenant.json" <<'PY'
import json,sys
tenant=json.load(open(sys.argv[1]))
assert tenant['surface']=='tenant'
assert tenant['hostname']=='snidect-technologies-main.finn3.com'
assert tenant['company']['name']=='Snidect Technologies'
print(tenant['company']['id'])
PY
)
python3 - "$secret" <<'PY' |
import json,pathlib,sys
print(json.dumps({'email':'gorilla@bayamtech.com','password':pathlib.Path(sys.argv[1]).read_text().strip()}))
PY
  curl --fail --silent --show-error -c "$work/cookies" -H "Origin: $base" \
    -H 'Content-Type: application/json' --data-binary @- "$base/api/auth/sign-in/email" > "$work/login.json"
chmod 600 "$work/cookies" "$work/login.json"

range='from=2025-12-26&to=2026-10-03'
curl --fail --silent --show-error -b "$work/cookies" "$base/api/me" > "$work/me.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/reports/summary?$range" > "$work/summary.json"
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/reports/details?$range" > "$work/details.json"

python3 - "$work" "$company" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); company=sys.argv[2]
read=lambda name: json.loads((root/f'{name}.json').read_text())
me,summary,details=read('me'),read('summary'),read('details')
assert me['role']=='super_admin' and me['authLevel']=='password'
expected={
  'sales':149782.86,
  'tax':1380.76,
  'expenses':22852,
  'cashIn':78228.75,
  'cashOut':16352,
  'cashFlow':61876.75,
  'quoted':79000,
  'convertedQuoted':158149.64,
}
actual={key:summary[key] for key in expected}
assert actual==expected,(actual,expected)
assert details['totals']==expected
assert details['counts']=={'sales':21,'expenses':5,'receipts':8,'quotes':16}
assert not details['limited']
assert len(details['sales'])==21 and len(details['expenses'])==5
assert len(details['receipts'])==8 and len(details['quotes'])==16
assert sum(row.get('status')=='Pending' for row in details['sales'])==13
assert sum(not row['converted'] for row in details['quotes'])==1
assert sum(row['converted'] for row in details['quotes'])==15
assert sum(bool(row.get('sourceQuoteNumber')) for row in details['sales'])==7
assert all(row['kind']=='Historical paid invoice' for row in details['receipts'])
assert all(row['id'] and row['date'] for group in ('sales','expenses','receipts','quotes') for row in details[group])
serialized=json.dumps(details)
assert 'notes' not in serialized.lower() and 'history' not in serialized.lower()
assert round(summary['cashIn']-summary['cashOut'],2)==summary['cashFlow']
print('production_snidect_accounting_reconciliation_passed')
print(json.dumps(expected,sort_keys=True))
PY

curl --fail --silent --show-error -b "$work/cookies" -H "Origin: $base" \
  -H 'Content-Type: application/json' -d '{}' "$base/api/auth/sign-out" > /dev/null
