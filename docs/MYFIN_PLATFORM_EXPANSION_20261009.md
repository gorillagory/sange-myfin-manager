# MyFin platform expansion

**Status:** development and production deployed and operationally verified;
interactive browser acceptance remains pending

**Recorded:** 9 October 2026

**Development baseline:** commit
`4b3095f38f27f71c5dd1e950474efbf660bcfcc3`, database migrations through
`0028`

**Production baseline:** commit
`4b3095f38f27f71c5dd1e950474efbf660bcfcc3`, database migrations through
`0028`

**Development/promotion source:**
`4b3095f38f27f71c5dd1e950474efbf660bcfcc3` on `develop`

The expansion is running in development and production from separate immutable
images built from the recorded source. The detailed backup, image, migration,
smoke and rollback receipts are in
`PLATFORM_EXPANSION_RELEASE_20261009.md`.

## Product and accounting decisions

1. MyFin is the system of record for products, prices, orders, sales, stock
   effects and accounting records. External commerce channels and payment
   providers enter through adapters and immutable evidence ledgers.
2. All authoritative prices and monetary adjustments use integer sen. The
   server prices public orders; a browser never establishes an authoritative
   promotion, voucher, tax, delivery fee or rounded total.
3. Quotes are pipeline documents. They are not revenue, cash or stock effects.
   An issued invoice becomes a receivable, an invoice payment becomes cash, and
   a POS/customer-order tender creates a paid sale.
4. Customer identity is separate from staff identity. One customer account may
   visit several workspaces, while loyalty, consent, student eligibility and
   order access remain workspace-scoped. A future SSO link must use a verified
   issuer and subject; email matching is not an identity link.
5. Existing products remain on catalog-stock behaviour until a versioned
   recipe is deliberately enabled. An enabled recipe makes the stock-room
   ledger authoritative for its ingredients.
6. Analytics projections are rebuildable. Source sales, invoice payments,
   expenses, stock ledgers and immutable provider evidence remain
   authoritative. Profit is withheld when cost coverage is incomplete.
7. Student eligibility is an expiring workspace attestation. Raw identity-card
   images are outside this release.

## Source capabilities in the candidate

### Commerce, customer accounts and fulfilment

- Guest checkout and optional customer accounts, with order history and
  workspace-specific loyalty.
- Tenant-isolated staff hosts and public storefront hosts, QR/table or pickup
  locations, live menu availability, idempotent order submission, staff
  acceptance, preparation, ready, collection/cancellation and exact-once
  pay-at-counter tender.
- Opt-in delivery zones with minimum order, exact delivery fee, lead time and a
  signed address/zone binding. Terminal delivery/contact data is redacted by a
  scheduled retention job.
- Versioned promotion and student pricing, voucher digests, usage caps,
  short-lived server quotes and immutable pricing snapshots. Order acceptance
  reserves promotion/voucher capacity; cancellation and expiry release it;
  tender consumes it exactly once.
- Delivery fee, promotion names and exact fixed discount amounts flow through
  the paid sale, receipt, PDF and financial reporting.

Customer-order payment remains pay at counter. No online acquirer or hosted
payment page is enabled. Delivery covers ordering and collection of delivery
details; dispatch, courier tracking and driver operations are not included.

### Inventory, recipes and procurement

- Count, weight and volume stock items, manual movements, wastage, supplier
  links, package conversion, camera/USB barcode scanning and a separate
  manufacturer/supplier/internal identifier directory.
- Purchase orders, partial goods receipts, supplier prices, batch/expiry
  evidence, weighted-average receipt cost and low-stock alert workflow.
- Opt-in immutable recipe/BOM versions connecting a sellable product to one or
  more stock items. POS tender aggregates shared ingredients, locks them in a
  stable order and writes exactly-once recipe consumption.
- Accepted public orders reserve the exact recipe version and component
  quantities in `customer_order_recipe_reservations`. Availability is computed
  across the complete cart so two products that share an ingredient cannot
  oversell it.
- The database stock-floor guard blocks counts, waste, procurement reversals,
  archive operations and other decrements below active recipe holds. Tender
  consumes the stored reservation rather than whatever recipe is current at
  payment time. Cancellation, rejection, expiry and maintenance release holds.
- Online tender uses server time. An offline sale that crosses a recipe-version
  boundary requires a manager to record `current_recipe` or `captured_recipe`
  during receipt review, instead of silently using a client-supplied date.

Manufacturer barcodes remain lookup identifiers. A GTIN does not by itself
contain MyFin's ingredient, unit conversion, cost or recipe data. See
[GS1 GTIN](https://www.gs1.org/standards/id-keys/gtin),
[GS1 barcodes](https://www.gs1.org/standards/barcodes) and
[GS1 Digital Link](https://www.gs1.org/standards/gs1-digital-link).

### Accounting, analytics and reporting

- POS sales, customer-order sales, quotes, invoices, invoice payments, expenses
  and cash-book movements contribute according to their accounting event.
  Imported Firebase document shapes are normalized so migrated sales and
  invoice payments appear in financial analysis.
- Daily, weekly, monthly and custom-date reporting with company, outlet,
  category, payment method and channel dimensions. Quote pipeline and converted
  value stay separate from recognized sales and cash.
- Operational/customer/student/inventory/product analytics, including order
  funnel, repeat/spend behaviour, promotion/discount participation, stock
  turnover, wastage, product performance and payment reconciliation evidence.
- Cost coverage, COGS and gross-margin views are restricted to owners and
  SuperAdmins. Student/customer cohort outputs suppress small cohorts.
- Company-scoped daily/weekly/monthly schedules, immutable in-app report
  snapshots and advisory demand forecasts. The worker uses retryable jobs and a
  process-owned, generation-fenced lease so an expired worker cannot finalize a
  newer worker's job.

Forecasts show their as-of time, history coverage and measured error. They do
not create purchase orders or stock movements. Scheduled delivery is in-app;
email delivery has not been connected to Mailcow.

### Student programme and administration

- Owner/SuperAdmin administration for pending, verified, rejected and revoked
  student eligibility, including institution, method, validity and non-sensitive
  reference evidence.
- Versioned student/public promotions, fixed or percentage benefits, scope,
  dates, caps and audience rules. Managers can read eligibility needed for
  operations but cannot mutate verification state.
- Procurement, storefront, promotion, student, analytics, payment-operations
  and scheduled-report workspaces are integrated into role-aware navigation.

### Payment and integration boundary

The candidate implements a disabled, provider-neutral foundation:

- versioned integration connection metadata with secret references only;
- append-only provider event, financial and reconciliation evidence;
- a pure Gokoo Malaysia financial mapper using exact MYR sen;
- an owner-only integration/evidence view and payment-operations workspace;
- strict tenant keys, immutable history and no runtime delete privilege.

The requested "GoCo" vendor identity is still ambiguous. Gokoo / 悟空海外 is
the closest verified match and documents Malaysia merchant, catalog, order and
financial-detail APIs. That makes it a plausible commerce channel; it does not
prove a general payment gateway contract. The current source performs no
provider network calls, OAuth flow, webhook handling, catalog/stock write-back,
provider-driven order mutation, payment capture, refund, settlement or cash
posting. Activation remains blocked by the gates in
`GOCO_GOKOO_INTEGRATION_ASSESSMENT.md`.

## Data and transaction architecture

```text
Staff POS / back office          Public shop / customer account
            |                                 |
            +----------- MyFin API -----------+
                            |
       +--------------------+-----------------------+
       |                    |                       |
 PostgreSQL ledgers   pricing/reservations      report worker
 sales, documents,    promotions, vouchers,     schedules, snapshots,
 stock, recipes       delivery, ingredients     retention, forecasts
       |                                            |
       +------------- adapter boundary -------------+
                     |                    |
             commerce channels      payment providers
             (Gokoo candidate)      (provider not selected)
```

The acceptance transaction for a recipe-backed online order locks current
recipe and stock evidence, verifies aggregate ingredient availability, then
creates catalog, promotion and recipe reservations atomically. Tender verifies
the stored immutable versions and writes the sale, payment, stock ledger,
reservation transitions and loyalty effect in one transaction. A failure rolls
all effects back; an idempotent replay returns the existing result.

Provider customer collection, receivable, fee/tax, refund and bank payout are
separate facts. A provider-side `pay_code` cannot establish MyFin cash. Bank
Negara Malaysia requires merchant-acquiring services to be registered; MyFin
should integrate a contracted acquirer rather than act as one. See the
[BNM merchant-acquiring policy](https://www.bnm.gov.my/-/pd-merchant-acquiring-services)
and [registration guidance](https://www.bnm.gov.my/application-for-approval-and-registration).

## Validation recorded for the source candidate

- The expansion through migration `0027` passed 186/186 server tests, 63/63
  frontend tests, the 27/27 receipt/PDF/POS/customer-order focused set and the
  production build.
- A disposable PostgreSQL 16.14 instance applied migrations `0001` through
  `0027` and passed promotion-cap concurrency, release/reuse, extension,
  rollback, post-expiry/version-change tender, exact replay and immutable
  redemption checks.
- The recipe-order candidate applied the complete migration chain `0001`
  through `0028` on disposable PostgreSQL 16.13 and passed its 8/8 adversarial
  database acceptance scenarios: concurrent shared-ingredient holds,
  version-bound exact-once tender/retry, atomic tender rollback, terminal/expiry
  release, trusted-time/offline-boundary handling, per-line count-unit
  validation, late manager-review recovery and the database stock floor.
- Migration `0028` also has structural/API tests for immutable evidence,
  transition guards, runtime grants and every terminal release path.
- Exact deployed source `4b3095f` passed 201/201 server tests, 66/66 frontend tests,
  11/11 offline tests, 7/7 management tests, 21/21 focused server checks,
  22/22 focused frontend checks, the production build with 57 offline assets
  and `git diff --check`.

Source validation is not deployment, live migration or browser acceptance.

## Hosting and recovery assessment

A read-only sample at approximately **03:34 MYT on 9 October 2026** found enough
capacity for the development release and a modest single-node production load.
It was not a load test.

| Component | Observation |
| --- | --- |
| `nexus-pbund` | Source/controller and sole Cloudflare tunnel process; 8 GiB RAM with about 7.8 GiB available; 40 GiB root with about 23 GiB available |
| `nexus-docker` | App runtimes and shared PostgreSQL; about 11.6 GiB RAM with 10 GiB available; `/srv/docker` had about 278 GiB available |
| MyFin development | Healthy API/web and running report worker on exact source `4b3095f`; database migrations through `0028`; automated public/authenticated smoke passed |
| MyFin production | Healthy API/web and running report worker on exact source `4b3095f`; database migrations through `0028`; public/authenticated reconciliation passed |
| PostgreSQL | `max_connections=100`; `archive_mode=off`; no continuous WAL archive/PITR observed |
| Backups | Manual checkpoints existed, but no MyFin backup timer was observed |
| Ingress | One `cloudflared` origin path; no second replica observed |

The topology remains:

- `nexus-pbund`: canonical source/controller and Cloudflare tunnel;
- `nexus-docker`: isolated MyFin web/API/report-worker containers and shared
  PostgreSQL;
- `temp-mailserver`: Mailcow only, reached later through a reviewed SMTP
  contract and never used as MyFin compute or storage.

Before public campaigns, payment callbacks or higher order volume, establish an
RPO/RTO, automate encrypted off-host database/uploads/config backups, test an
isolated restore, add PostgreSQL PITR through a coordinated shared-platform
change, and run a second `cloudflared` replica on another host. Also load-test
menu, quote, order, tender and one-year report paths while observing pool usage,
locks, I/O and container memory. See the
[PostgreSQL 16 PITR documentation](https://www.postgresql.org/docs/16/continuous-archiving.html)
and [Cloudflare Tunnel high availability](https://developers.cloudflare.com/tunnel/configuration/).

## Remaining programme

| Area | Source status | Remaining work or gate |
| --- | --- | --- |
| Ordering | Pickup/table, opt-in delivery, customer history and pay-at-counter deployed in development | Authenticated development browser acceptance, public-shop configuration, later online payment and courier operations |
| Pricing | Promotions, vouchers, student rules and reservation lifecycle implemented for the storefront | Validate live policy/data; manual POS/documents do not automatically apply storefront rules |
| Inventory | Recipes, ingredient reservations, procurement, identifiers, cost and low-stock workflow implemented | Reconcile opening counts/recipes and approve each opt-in recipe before enabling it |
| Analytics | Dynamic operational, customer, student, inventory and finance views deployed; API totals reconcile in development | Complete authenticated chart/drill-down browser acceptance and performance-test large periods |
| Reporting | In-app schedules, worker and advisory forecasts deployed in development and production | Exercise scheduled-report UI; email delivery remains future work |
| Payments | Evidence/reconciliation and operations view implemented | Select contracted acquirer; add hosted intents, signed callbacks, refunds and settlement reconciliation |
| Gokoo | Disabled metadata/mapper foundation implemented | Confirm vendor identity and contract, then sandbox read-only shadow reconciliation before any write path |
| Recovery | Development and production backups, off-host checksums and isolated restore drills completed | Automate the cycle; add PITR and a second tunnel replica |

Every promotion follows `develop -> staging -> main`, uses additive migrations,
backs up before migration, deploys exact image IDs and retains the prior images.
No destructive down-migration is part of rollback. The release-specific gates
and acceptance record are in `PLATFORM_EXPANSION_RELEASE_20261009.md`.

## Acceptance measures

- No duplicate sale, payment, stock, loyalty, promotion or voucher effect under
  retry or concurrency.
- Accepted recipe-backed orders cannot be oversold through another order,
  manual stock edit, wastage or procurement reversal.
- Opening stock plus immutable deltas equals the displayed balance.
- Filtered report totals equal included detail rows to the sen, and migrated
  legacy sales/invoice payments reconcile with their source facts.
- Quotes never count as revenue and never deduct inventory.
- Marketplace customer payment, provider receivable, fees and bank settlement
  remain separately reconcilable.
- Cross-workspace customer login never merges loyalty, consent or eligibility.
- Operator responses contain no provider secrets, cost, margin or student
  verification evidence outside their role.
- Student and delivery records have explicit purpose, retention and redaction
  behaviour.
- Backups have fresh checksums and a successful isolated restore receipt.
- Future production promotion uses the exact reviewed/tested SHA and image IDs
  with recorded development, staging or explicitly authorized expedited gates.
