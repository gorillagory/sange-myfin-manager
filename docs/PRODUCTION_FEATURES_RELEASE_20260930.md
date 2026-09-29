# MyFin Orders, reporting and mobile stock release — 30 September 2026

The accepted second release is live at **https://pos.finn3.com** and the
existing tenant URL **https://bfsb-bali.finn3.com**. It follows the SKU and
inventory production promotion in [PRODUCTION_OPERATIONS_RELEASE_20260930.md](PRODUCTION_OPERATIONS_RELEASE_20260930.md).
The tested code is `00c6ebd` on `develop`, `staging` and `main`. The
production source link points at
`nexus-docker:/srv/docker/releases/sange-myfin-manager/00c6ebd`.

## What changed

- Navigation is grouped as Workspace, Inventory, Finance, Analytics,
  Administration, Settings and User Administration. The checkout item grid is
  denser; the category/section divider no longer crosses the buttons.
- Every server-confirmed paid POS sale creates a fulfillment order and an
  append-only history event in the same database transaction. The queue has
  pending, preparing, ready and completed states, a POS badge, retry-safe
  transitions and a visible-device refresh cadence. Orders may have no
  customer. Historical development receipts were backfilled as completed;
  their original fulfillment progress was not known. Production had no
  transactions at the recovery checkpoint, so no historical production orders
  required backfill.
- Financial Analysis supports daily, weekly and monthly grouping and a date
  range, with bar hover/focus breakdowns and a clickable detail view. Sales,
  tax, expenses and cash flow remain the approved report measures.
  Consolidation separates currencies and obeys the authorized company scope.
- Stock item and scannable-package forms have mobile camera scan controls for
  one-dimensional barcodes and QR codes, in addition to manual entry.

## Recovery point and promotion

The production API was stopped briefly for a quiescent database and upload
backup, then restarted healthy. The local backup is
`nexus-docker:/srv/docker/backups/myfin-prod/pre-operations-20260929T191223Z`;
the checksum-matched off-host copy is
`nexus-pbund:/root/myfin-backups/myfin-prod/pre-operations-20260929T191223Z`.

| File | SHA-256 |
| --- | --- |
| `database.dump` | `5ce0141b013250ae703cd04bbfeeeca7651e41a2f98d0a4a76b6e584e5078d00` |
| `uploads.tar.gz` | `7bff2cf2c1861a34d4c7fcf44ef8b198959dc5c2b75dc9d0afe68de3620bcb9f` |

The disposable restore reported 15 migrations, one company, 45 products,
zero transactions and zero expenses; the test database was removed. No
production business record was created for acceptance.

The exact tested development images were retagged, without rebuilding the
previous production tags:

| Service | Active image | Image ID |
| --- | --- | --- |
| API | `myfin-api:prod-features-00c6ebd` | `sha256:685752816f1e1b6473c7e4635a30e85edd3381070fb436f697cd36e870ca72c8` |
| Web | `myfin-web:prod-features-00c6ebd` | `sha256:55b43eebe67cf31ab179a0ca10c15ea08268d657f6082c33221cf81ec9436858` |

The protected previous runtime is
`/srv/docker/secrets/myfin-prod/runtime-before-features-00c6ebd.env`;
the active selected copy is `runtime-features-00c6ebd.env`. Both and
`runtime.env` have mode 0600. Previous images remain tagged
`myfin-api:prod-operations-5145384` and
`myfin-web:prod-operations-5145384` with their original image IDs.

The old production API was held stopped during migrations `0016` and `0017`.
This prevents a paid checkout from committing between the order backfill and
trigger installation in `0016`. The migration applied two changes and runtime
grants succeeded using `MYFIN_PG_ADMIN_ROLE=platform`. Only the MyFin
production web/API pair was recreated. Both became healthy.

## Acceptance and recovery

The development release passed frontend/domain tests (21), offline tests
(11), management tests (5), server tests (37), build, isolated PostgreSQL 16
migrations and the 10-check Phase06 API acceptance. Development public HTTPS
Orders, reports and consolidation checks passed. Browser review verified the
checkout layout, order list/history, reporting bar detail and stock item and
packaging scan controls.

After production deployment, LAN health/auth smoke, authenticated public
inventory/stock reads, and authenticated public Orders/reporting/consolidation
checks passed. Browser review on `bfsb-bali.finn3.com` showed the new
navigation and Orders route with a zero-item production queue. Physical mobile
camera scanning and printer hardware were not exercised in this release.

For an application rollback, restore the previous protected runtime (or
select its previous image tags) and run the guarded production up command.
Migrations `0016` and `0017` are additive; the order trigger also services
checkout writes made by the prior API. Do **not** restore the pre-release
database after live business writes without reconciling them: that would
discard transactions and fulfillment events. Preserve the backup for a
separately reviewed database recovery.
