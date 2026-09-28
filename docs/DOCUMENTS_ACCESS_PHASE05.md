# Phase05 — documents and role access

Implementation and isolated acceptance are complete. **Deployment: deployed and verified; ready for user browser acceptance**. The public development URL is **https://dev-pos.finn3.com**. Final release fields and recovery receipts belong to [MYFIN_DEV_ACCEPTANCE.md](MYFIN_DEV_ACCEPTANCE.md). This phase does not import historical Firebase data or perform production cutover.

## Implemented access model

| Capability | Staff | Manager | Workspace owner |
| --- | --- | --- | --- |
| Checkout / receipts | Own checkout and own receipt reprints | Company operations and receipts | All companies |
| Quote / invoice drafts | Own or explicitly assigned drafts | Company document review and management | All companies |
| Issue, convert, record payment | Denied | Company actions with validation/audit | All companies |
| Catalog | Selling prices and stock availability | Selling price, stock, variants, cost-free CSV | Includes acquisition costs |
| Purchase costs / margins | Hidden | Hidden; operational edits preserve costs | Available |
| Expenses / company financial reports | Hidden | Hidden | Available |
| Financial bulk exports | Denied | Denied | Authorized owner scope |
| Customers / suppliers | Customer lookup/create; no existing-contact edit | Customer management; no supplier data | Includes suppliers |
| Templates | Use published versions in drafts | Configure and publish company templates | All companies |
| Account management | Own profile | Staff accounts in own company only | Includes manager appointments |
| Company enrollment / lifecycle | Denied | Denied | Available |

Managers see amounts on individual operational documents, without company financial dashboards, expenses or costs. The operational Overview contains stock, workflow and queue information. Owner Financial reports use actual recorded POS and invoice payments, including partial payments, with Kuala Lumpur date boundaries. Cash surplus is collected payments less recorded expenses; it is not net profit or inventory valuation.

Staff checkout discounts default to 0% until an owner sets the limit. Staff cannot override catalog prices or tax. Manager checkout exceptions require a reason; an above-policy draft discount requires an issuance reason. Draft amounts remain proposals until a manager or owner issues the document.

Server reads/writes, account actions, private files and nested response projections enforce access. A manager cannot overwrite acquisition costs through catalog edits, including concurrent updates. Staff checkout can save a new customer but preserves existing directory contact data when a receipt uses a different email. Session revocation is rechecked during protected operations.

## Documents, templates and payments

A shared document model drives previews, structured PDFs, thermal output and email draft text. A4 invoices/quotes and 58/80 mm receipts include applicable business/customer details, lines, monetary discounts, tax, payment instructions, terms and numbering. Clean, Modern and Corporate layouts use saved published template versions. A draft following the company default resolves its authoritative template ID and version; issue checks both so a different default cannot silently replace an accepted preview.

Issued documents keep immutable company, customer, amount and template snapshots. Later branding, customer or template edits do not change reprints. Files referenced by saved snapshots remain protected. Company/type numbering, payment IDs and receipt IDs protect retries against duplicate issue/payment/stock effects. Partial and final invoice payments update recorded balance without rewriting issued content. Unpaid voids and linked correction drafts retain the original history.

Manual invoices record billing and confirmed payments. **Issuing an invoice or recording its payment does not adjust catalog stock; Checkout does.** Recording a payment does not initiate a bank, card or QR transaction. Paid refunds, credit notes and stock returns are outside this phase; there is no action that claims a processor returned money.

## Offline payment recovery

The version3 device cache removes confidential fields from old catalog, profile, draft and outbox records while retaining original paid receipt IDs, cashier/company scope, prices, totals, tender and change. Even owner caches omit confidential finance/cost data. Logout, role changes, failed submissions and upgrades do not delete pending paid receipts. Reconnect revalidates the current session and role before loading or syncing.

Price, tax or merchant-detail drift enters Payment reviews. Staff submit their original paid intent; managers/owners approve the original amount with a reason. Approval records the original cashier and receipt once; the cashier then retries sync, and the queue clears only after checkout confirms that ID. Failed or uncertain review submissions remain safely retryable. Never collect payment again merely because sync is pending.

Deleted products/options need an owner to restore or reconcile the original catalog identity before approval. The app preserves that paid intent; it cannot invent stock or acquisition costs. Retain the original browser data and recovery export. Offline devices cannot learn later permission revocations immediately; they retain last-verified operational access until reconnection.

## Accepted evidence

All data-writing tests ran on the disposable `myfin-phase05-pg-20260913` PostgreSQL cluster, guarded by loopback port 25435 and an explicit cluster marker. The live shared database was not a test target.

- `reports/final-frontend-tests.json`: 49 frontend/domain tests passed.
- `reports/backend-freeze.json`: 19 document/access PostgreSQL groups, 15 API foundation tests and 10 management PostgreSQL regression groups passed; migration readiness is `0012_document_invariants.sql`.
- `reports/phase05-tested-release.json`: exact accepted source and images; final isolated management, checkout/offline and document/access browser suites passed 25 checkpoints with no reported runtime errors.
- `reports/pdf-visual-acceptance.json`: 9 samples / 16 pages reviewed, including all three layouts, an 8-page quotation and 58/80 mm paid/pending receipts.
- `reports/browser-pdf-acceptance.json`: 6 actual browser PDFs reviewed; draft/pending/paid labels, monetary discounts, balance and unchanged reprints after branding changes verified.

Packet: `/root/myfin-jobs/phase05-documents-access-20260913`. The source-before archive, hashes and Git bundle preserve all 196 pre-existing source files and dirty work. Backup, MyFin-only deployment, public HTTPS acceptance and isolated-resource cleanup receipts are finalized in this packet.

## Remaining acceptance boundaries

Physical receipt/label printers, paper settings, cutters and scanner hardware need checks on the user's devices. PDFs currently use built-in Latin fonts; a full CJK font is not embedded. Do not treat the tested Latin samples as certification of CJK document output. Browser print may use installed system fonts, but target-language output still needs its own acceptance.

Merchant settlement, automated SMTP/invitations/reset delivery, production Firebase import and identity mapping, a production database/deployment and publishing `pos.finn3.com` remain separate work. Preserve temp-mailserver and the other existing applications throughout.
