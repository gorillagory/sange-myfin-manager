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
curl --fail --silent --show-error -b "$work/cookies" "$base/api/me" > "$work/me.json"
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
curl --fail --silent --show-error -b "$work/cookies" "$base/api/companies/$company/documents" > "$work/documents.json"
pages=0
after=
: > "$work/transactions-pages.jsonl"
while :; do
  pages=$((pages+1))
  test "$pages" -le 100
  if test -n "$after"; then
    curl --fail --silent --show-error -b "$work/cookies" --get \
      --data-urlencode 'limit=500' --data-urlencode "after=$after" \
      "$base/api/companies/$company/transactions" > "$work/transactions-page.json"
  else
    curl --fail --silent --show-error -b "$work/cookies" \
      "$base/api/companies/$company/transactions?limit=500" > "$work/transactions-page.json"
  fi
  after=$(python3 - "$work/transactions-page.json" "$work/transactions-pages.jsonl" <<'PY'
import json,pathlib,sys
page=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert isinstance(page,dict) and isinstance(page.get('rows'),list)
assert page.get('next') is None or isinstance(page['next'],str)
with pathlib.Path(sys.argv[2]).open('a') as stream:
    stream.write(json.dumps(page,separators=(',',':'))+'\n')
print(page.get('next') or '')
PY
)
  test -n "$after" || break
done
python3 - "$work" "$company" <<'PY'
import json,math,pathlib,re,sys
root=pathlib.Path(sys.argv[1]); company=sys.argv[2]
def read(name): return json.loads((root/f'{name}.json').read_text())
def require_keys(value,keys,label):
    assert isinstance(value,dict),f'{label} must be an object'
    missing=[key for key in keys if key not in value]
    assert not missing,f'{label} missing keys: {missing}'
def require_number(value,label):
    assert isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value),f'{label} must be a finite number'
def require_totals(value,label):
    require_keys(value,TOTAL_KEYS,label)
    for key in TOTAL_KEYS: require_number(value[key],f'{label}.{key}')
    assert round(value['cashIn']-value['cashOut'],2)==round(value['cashFlow'],2),f'{label} cash flow does not reconcile'
    return {key:value[key] for key in TOTAL_KEYS}
TOTAL_KEYS=('cashIn','cashOut','cashFlow','sales','tax','expenses','quoted','convertedQuoted')
DETAIL_COLLECTIONS=('sales','expenses','receipts','quotes')
DETAIL_ROW_KEYS={
    'sales':('id','date','kind','number','customer','total','tax','fromQuote'),
    'expenses':('id','date','description','category','payee','number','kind','status','amount','cashImpact'),
    'receipts':('id','date','kind','number','amount'),
    'quotes':('id','date','kind','number','customer','status','total','converted'),
}
me=read('me'); orders=read('orders'); counts=read('orders-summary')['counts']; documents=read('documents')
summary=read('summary'); details=read('details'); consolidation=read('consolidation')
transaction_pages=[json.loads(line) for line in (root/'transactions-pages.jsonl').read_text().splitlines()]
transactions=[row for page in transaction_pages for row in page['rows']]
assert me.get('authLevel')=='password' and me.get('role') in ('super_admin','workspace_owner','manager')
assert isinstance(documents,list)
assert isinstance(orders['rows'],list) and isinstance(counts['active'],int)
summary_totals=require_totals(summary,'summary')
details_totals=require_totals(details.get('totals'),'details.totals')
assert summary_totals==details_totals,'summary and detail totals differ'
require_keys(summary,('from','to','basis','daily'),'summary')
assert isinstance(summary['basis'],str) and summary['basis']
assert isinstance(summary['daily'],list)
for index,row in enumerate(summary['daily']):
    require_keys(row,('date','sales','tax','expenses','cashIn','cashOut','cashFlow'),f'summary.daily[{index}]')
    for key in ('sales','tax','expenses','cashIn','cashOut','cashFlow'): require_number(row[key],f'summary.daily[{index}].{key}')
require_keys(details,('from','to','totals','basis','counts','limited',*DETAIL_COLLECTIONS),'details')
assert (summary['from'],summary['to'],summary['basis'])==(details['from'],details['to'],details['basis'])
assert isinstance(details['limited'],bool) and isinstance(details['counts'],dict)
for collection in DETAIL_COLLECTIONS:
    rows=details[collection]
    count=details['counts'].get(collection)
    assert isinstance(rows,list),f'details.{collection} must be an array'
    assert isinstance(count,int) and not isinstance(count,bool) and count>=len(rows),f'details.counts.{collection} is invalid'
    if not details['limited']: assert count==len(rows),f'details.counts.{collection} does not match its array'
    for index,row in enumerate(rows): require_keys(row,DETAIL_ROW_KEYS[collection],f'details.{collection}[{index}]')
assert len(consolidation['companies'])==1 and consolidation['companies'][0]['id']==company
require_keys(consolidation,('from','to','workspaceId','workspaces','companies'),'consolidation')
assert (consolidation['from'],consolidation['to'])==(summary['from'],summary['to'])
for index,row in enumerate(consolidation['companies']): require_totals(row,f'consolidation.companies[{index}]')
if me['role']=='manager':
    assert not re.search(r'cost|margin|profit|surplus|valuation',json.dumps(details),re.I),'manager report exposes confidential fields'
    expected={row['id'] for row in details['sales'] if row.get('status') in ('Pending','Partially paid')}
    if expected:
        transaction_ids={row['id'] for row in transactions}; document_ids={row['id'] for row in documents}; receipt_ids={row['id'] for row in details['receipts']}
        assert expected<=transaction_ids,'pending legacy invoices are missing from the manager transaction feed'
        assert expected<=document_ids,'pending legacy invoices are missing from the manager document list'
        assert expected.isdisjoint(receipt_ids),'unpaid legacy invoices were reported as historical cash receipts'
        print(f'manager_visibility_passed: {len(expected)} pending legacy invoice(s)')
    else:
        print('manager_visibility_skipped: no legacy Pending/Partially paid invoices in the selected range')
else:
    print(f"manager_visibility_skipped: authenticated role is {me['role']}")
print('development_public_feature_smoke_passed')
PY
curl --fail --silent --show-error -b "$work/cookies" -H "Origin: $base" \
  -H 'Content-Type: application/json' -d '{}' "$base/api/auth/sign-out" > /dev/null
