# MyFin development acceptance — Phase05, 13 September 2026

**Release status: deployed and verified; ready for user browser acceptance**. Open **https://dev-pos.finn3.com**. This is the development shop; **pos.finn3.com remains reserved and unpublished**.

[Phase05 documents/access](DOCUMENTS_ACCESS_PHASE05.md) defines the current behavior. [Continuation](NEXUS_CONTINUATION.md) identifies the current packet and next work. The old image IDs, migration counts and DNS publication record are preserved separately in [historical Phase03/04 acceptance](MYFIN_DEV_ACCEPTANCE_PHASE03_04_HISTORY.md); those are dated records, not current execution instructions.

## Open the development shop

No SSH forward or this Windows PC is needed to use the public URL. The synthetic development owner is `operator@myfin.test`. Retrieve its password through the existing trusted SSH/Tailscale route from the protected file `/root/myfin-recovery/dev-20260912/secrets/acceptance-password` on nexus-pbund. Do not paste credentials into chat, source or reports. Use synthetic data for acceptance.

## Roles to verify

| Account | Expected experience |
| --- | --- |
| Staff | Checkout, own receipts, customer lookup/create, read-only cost-free catalog, own/assigned quote and invoice drafts. No issue, payment, financial report, expense, supplier, inventory-write or account-management actions. |
| Manager | Company operations, document issue/conversion/payments, published templates, Staff accounts and cost-free inventory CSV. No purchase costs, margins, expenses, company financial reports, suppliers or manager appointments. |
| Owner | Cross-company administration, manager appointments, acquisition costs, expenses, company financial reports and staff discount policy. |

A manager may see an individual invoice or receipt amount. That does not grant financial summaries or cost access. Financial reports include partial invoice payments by their recorded payment date. Manual invoice issue/payment does not move stock; POS checkout does.

## Browser acceptance on your devices

1. Sign in and open the intended development company. Confirm the role-specific navigation and direct-route restrictions. Check desktop and your normal mobile viewport.
2. Create a synthetic customer. As Staff, prepare an invoice or quote draft. Check quantity, price, the discount's monetary deduction, tax and total. Staff cannot issue it or record payment.
3. As Manager, preview/issue the document, record partial/final payments and check the remaining balance. Convert an issued quote into an invoice draft. Inspect the published template and its exact version. Above-policy issuance requires an approval reason.
4. Download an A4 invoice/quote and 58/80 mm receipt. Confirm business/customer details, labels, bank/payment instructions, wrapped lines and page boundaries. Change current branding and reprint an already issued document; the original must remain intact.
5. Perform a synthetic POS sale, including the variants/fractional quantities relevant to your shop. Confirm original receipt number, amount, tender and change. QR/card confirmation happens on the merchant device; MyFin records that confirmation.
6. Load a company while online, then test a paid offline sale. Keep its browser data, reload and reconnect as the same operator. A pricing/tax/merchant conflict should appear in Payment reviews; manager approval keeps the original amount/cashier, and cashier retry clears the queue without another payment or stock deduction.
7. Confirm managers can export inventory without a cost column, while Staff cannot export or modify inventory. Check owner financial reports separately. Check actual printers/scanners after browser/PDF acceptance.

The automated isolated tests already exercise these paths; this review confirms the user's own devices and operational fit. Do not turn this checklist into real production sales or imports.

## Current topology and verified rollout fields

| Component | Role |
| --- | --- |
| nexus-pbund, CT101 / 192.168.1.103 | Canonical source/controller and existing Cloudflare Tunnel |
| nexus-docker, CT100 / 192.168.1.100 | MyFin web/API runtime and shared PostgreSQL infrastructure |
| temp-mailserver, CT200 / 192.168.1.18 | Existing Mailcow/mail data; preserved outside this release |
| Squarespace / Cloudflare | Registrar / authoritative DNS and public HTTPS tunnel ingress |

Route: `dev-pos.finn3.com` → existing tunnel → `http://192.168.1.100:8083` → MyFin web → private API. The API uses its isolated `myfin_dev` database and restricted roles on `nexus-shared-postgres:5432`, through `nexus-data`. Canonical source remains `nexus-pbund:/root/workspaces/sange-myfin-manager`; runtime artifacts are `/srv/docker/apps/sange-myfin-manager` on nexus-docker.

| Release field | Verified value |
| --- | --- |
| Deployed / public-accepted time | 2026-09-13T03:24:04.641728+00:00; public HTTPS accepted 2026-09-13T03:31:56.953628+00:00 |
| Source archive SHA256 | d8c1323780675167c2fe5734433fb234e66f3604f40c40177ae1764c145e51c8 |
| API image ID | sha256:3ca885dd5a6ca70f9ea1617717b9702a4ac504411956f1454c8742530222f970 |
| Web image ID | sha256:24da68228acb0ba1b020721057f11bd6d12025a33d5ddf770f6c4a80b0ec1334 |
| Migration ledger | 12 applied, 0001_foundation.sql through 0012_document_invariants.sql |
| Public HTTPS/authentication receipt | /root/myfin-jobs/phase05-documents-access-20260913/reports/https-acceptance.json (passed) |
| Other observed applications preserved | All 17 other observed containers retained IDs, states and start times; original 15 platform containers plus two independent Sange service-desk test containers |
| Isolated test cleanup | Passed: owned test API/web/PostgreSQL containers, networks and upload volume removed; ports 25435/28085 and controller forward closed; images/evidence retained |

Compose project remains `myfin-dev`, with `myfin-dev-web-1` and `myfin-dev-api-1`. Uploads use private `myfin-dev-uploads`; runtime configuration/secrets remain outside source under `/srv/docker/secrets/myfin-dev`. The public API must retain `AUTH_BASE_URL=https://dev-pos.finn3.com` and no `AUTH_LOCAL_TEST` override. These production-style hardening settings protect the DEVELOPMENT environment.

## Evidence

Current packet: `/root/myfin-jobs/phase05-documents-access-20260913`. Final records are `reports/result.json`, `reports/phase05-tested-release.json` and the public rollout receipt above. Confirm their status before continuing from another computer; an old running-stage progress file or Phase03 result is not the current release result.

Isolated acceptance passed 49 frontend/domain tests, 19 document/access PostgreSQL groups, 15 API foundation tests and 10 management PostgreSQL groups. Three browser suites passed 25 checkpoints (8 management, 7 checkout/offline, 10 documents/access). `reports/pdf-visual-acceptance.json` records 9 samples/16 reviewed pages; `reports/browser-pdf-acceptance.json` records 6 browser-generated documents, including matching historical reprints after branding edits. These are isolated-test results, distinct from the public HTTPS receipt.

## Recovery and limits

Verified pre-release backup and off-host copy: **reports/offhost-backup-verified.json: database/uploads pair in nexus-docker:/srv/docker/backups/myfin-dev/phase05-before-20260913 and checksum-verified nexus-pbund:/root/myfin-recovery/dev-20260912/phase05-before-20260913**. Release/rollback receipt: **nexus-docker:/srv/docker/myfin-deployments/phase05-20260913 contains runtime-before/, runtime-before.env, images-before.json, prepared.json and rollout-status.json; no live rollback or restore was performed**. Preserve accepted images, source archives, database/private-file backup pairs and protected runtime configuration. Prefer a forward fix when practical: an older application image may restore superseded permissions or lifecycle behavior. Any rollback must check schema/data compatibility and queued receipt handling; do not blindly run an older deployment guide or restore only one half of the database/files pair. DNS rollback is not data rollback. The pre-release backup has nine migrations. Restore it using the preserved Phase04 scripts/grants, or migrate it to twelve before applying Phase05 grants. After new Phase05 writes, prefer a forward fix; restoring the old backup would discard those writes.

Keep the original device's data until every paid receipt is confirmed. Use its recovery export if needed, sign in as the same cashier, and retry sync. Pricing/tax/merchant changes have a manager review path; deleted product/variant identities require owner catalog reconciliation before approval. Never take payment again because a saved receipt remains queued. A disconnected device cannot receive immediate access revocation; reconnect refreshes the current session/role.

Physical printers and scanner hardware are not certified by browser/PDF tests. Built-in PDF fonts cover the tested Latin samples; full CJK fonts are not embedded, so target-language document output needs further work and acceptance. Refunds, credit notes and stock returns are not implemented; card/QR settlement remains external. Automated SMTP/invitation/password-reset delivery is separate from recording receipt email and opening an email draft.

The earlier Firebase extraction contains 118 Firestore documents and 9 authentication metadata profiles with credentials excluded, and 0 current Storage objects. These are exported, **not imported**. Production Firebase remains active and unchanged. Production needs a reviewed isolated import rehearsal, ID/identity/finance reconciliation, old-origin outbox drain, a separate production database/deployment and explicit cutover before publishing `pos.finn3.com`.

## Continue from another computer

Use trusted SSH/Tailscale to nexus-pbund and work in `/root/workspaces/sange-myfin-manager`. Read this guide, `docs/NEXUS_CONTINUATION.md` and the finalized Phase05 packet. Preserve existing dirty work and coordinate a single source writer. The old Windows/imported checkouts remain references. No new deployment, data import or source writer is implied merely by opening the guide.
