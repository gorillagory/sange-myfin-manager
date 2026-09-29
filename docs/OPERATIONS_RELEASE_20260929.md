# MyFin development operations release — 29 September 2026

This release is deployed to **https://dev-pos.bayam.live** from `develop` commit
`5145384372d8990f1fa04c5d84c292b50d45f763`. Production was not changed.
The authenticated read-only browser walkthrough passed on 30 September 2026.
Owner signoff on the remaining write flows is still open.

## Behavior

- Counter POS receipts use two-decimal money and the Malaysian nearest-five-sen
  rule on the final bill. The signed adjustment appears as **Rounding** in
  checkout, receipt preview, and PDF. Legacy version-2 paid device receipts
  retain their original amounts on retry.
- Inventory category and subcategory values are editable in product records and
  CSV, filterable in inventory, and grouped on the POS. Company theme colors are
  configurable. Contacts now have separate Customer and Supplier tabs under
  Administration.
- Owner and manager can review an unresolved paid receipt before either posting
  it or dismissing it with a reason. A dismissal remains in the audit trail, and
  the original device queue clears only after the server confirms a terminal
  state. Operator expense voids transmit the manager approval code.
- Expense CSV import has a template, preview, supplier matching, atomic batches,
  and an idempotency key. Exported legacy timestamps become importable business
  dates. Stock records are separate from sellable products and support counted,
  weight, and volume units; packaging conversions; manual or barcode/QR entry;
  optional supplier and expense references; immutable movement history; archive
  and restore.
- The old 30-second full-data refresh is removed. Successful checkout merges the
  confirmed receipt, refetches the product catalog and a changed customer where
  needed, and avoids reloading financial and stock history after each sale.
  Initial and stale workspace refreshes still load historical collections;
  pagination and report queries are a later scaling improvement.

## Release and recovery evidence

| Item | Verified value |
| --- | --- |
| Development API image | `myfin-api:operations-5145384` / `sha256:9e2fb4b27241b9bfe34db19a310f34aa5ed76c2ed576f0b178da2feeab24ec23` |
| Development web image | `myfin-web:operations-5145384` / `sha256:c69145651f08d1162800f1fca5fa4ea9bda43be2d5667909305825978579c680` |
| Source snapshot | `nexus-docker:/srv/docker/releases/sange-myfin-manager/5145384` |
| Active protected runtime | `nexus-docker:/srv/docker/secrets/myfin-dev/runtime.env`; versioned copy `runtime-operations-5145384.env` |
| Prior runtime | `runtime-before-operations-5145384.env`; prior source `e0a438b` and prior images retained |
| Pre-release DB and uploads | `nexus-docker:/srv/docker/backups/myfin-dev/pre-operations-20260929T1407Z` |
| Verified off-host copy | `nexus-pbund:/root/myfin-backups/pre-operations-20260929T1407Z` |

The backup was taken with the development API stopped, both archive checksums
passed on both hosts, and the API restarted healthy. The PostgreSQL dump was
restored with `pg_restore --no-owner --no-acl --exit-on-error` into a separate
disposable database; aggregate schema and row counts matched. The disposable
container, network, tunnel, and credentials were removed. Never restore this
pre-release snapshot over a development database after new writes without
reviewing the loss of later data, and restore database and uploads together.

The isolated Phase06 PostgreSQL target applied all 15 migrations and applied
zero on repeat. Server unit tests passed 25/25, workspace/payment acceptance
10/10, and new operations acceptance 6/6. Local POS/inventory/operations,
offline, management, focused permission/receipt/refresh/theme, and production
web build checks passed. Two new development migrations applied; LAN and public
HTTPS health returned ready; public authenticated tenancy/report acceptance
passed. Both development containers are healthy. Production containers retain
their earlier image tags and remained healthy.

The public operations smoke check passed against `dev-pos.bayam.live` on
30 September. It used the protected development test account and verified
authenticated read access to products, transactions, contacts, expenses, stock
items, stock movements, and receipt reviews. It did not create business data.
To repeat it from `nexus-pbund` after pulling `develop`:

```bash
ssh 192.168.1.100 bash -s < /root/workspaces/sange-myfin-manager/scripts/deploy/public-operations-smoke.sh
```

In the signed-in Chrome walkthrough, the inventory editor exposed editable
category and subcategory fields, and the POS grouped the existing products by
those fields. An unsold RM5.20 espresso basket showed RM0.31 tax, RM5.51 before
rounding, **Rounding −RM0.01**, and RM5.50 due; the basket was cleared without
recording a sale. Customer and Supplier tabs, the expense CSV controls, stock
item editor with count/weight/volume and packaging fields, the company color
picker, and the Payment reviews page all rendered. The browser reported no page
errors during this walkthrough. No business records or settings were saved.

## Browser acceptance

Sign in at **https://dev-pos.bayam.live** and check the remaining write flows
in the development company, using clearly marked test records:

1. In Device & printing, change a theme color, save, and reload. Confirm it stays
   readable and persisted.
2. Preview a synthetic expense CSV and confirm supplier matching. Avoid
   importing live business data as a browser test.
3. Open Stock records; create a synthetic item, receive/count it, inspect its
   movement history, and archive/restore it. Inspect Receipt reviews without
   dismissing a real paid receipt.
4. If another device is available, confirm checkout and sync refresh without
   repeated full-page loading.

Production promotion and any historical-data cutover require separate review
after this browser acceptance. `staging` and `main` intentionally remain on
their accepted release commits.
