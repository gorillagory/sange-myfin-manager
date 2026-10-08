# MyFin platform expansion

**Status:** implementation programme, 9 October 2026  
**Baseline:** `6e08462` on the existing PostgreSQL/Fastify/Vue deployment  
**Scope:** payments and commerce channels, online ordering, inventory, analytics,
student programmes, and the nexus hosting platform

## Decisions

1. MyFin remains the system of record for products, prices, orders, sales,
   stock effects and accounting records. External marketplaces and payment
   providers enter through adapters and immutable event ledgers.
2. "GoCo" is not treated as an identified vendor yet. The closest verified
   match is Gokoo / 悟空海外, whose partner API includes Malaysia marketplace
   orders, catalog/stock synchronisation and financial details. That is a
   commerce-channel integration, not evidence of a general payment gateway.
   Production credentials and callbacks remain disabled until the vendor and
   callback-signature contract are confirmed.
3. One server-side pricing engine will eventually price POS and storefront
   orders. Promotions, vouchers, student prices and loyalty redemptions will be
   immutable adjustments on a sale or order; clients will not calculate an
   authoritative discount.
4. Existing ordering, customer accounts, reservations and loyalty are extended
   rather than replaced. The current pickup/table and pay-at-counter flow stays
   available while delivery and online payment are added behind feature gates.
5. Existing stock-room records become the ingredient/consumable ledger. A
   versioned recipe/BOM bridges sellable products to stock items. Existing
   products remain in legacy catalog-stock mode until each recipe is reconciled
   and explicitly enabled.
6. Financial records and immutable ledgers stay authoritative. Analytics facts
   and forecasts are rebuildable projections with reconciliation and coverage
   indicators. Profit is never presented when cost coverage is incomplete.
7. Customer identity stays separate from staff identity. A future SSO link is
   made only from a verified issuer and subject, never by matching an email
   string. Loyalty remains separate per workspace.
8. Student eligibility is an expiring workspace attestation. MyFin should keep
   institution, status, dates and a reference digest; raw identity-card images
   are outside the first release. Operators see eligibility and the applied
   benefit, while reviewers see the administration record.

## What already works

The current release already provides:

- tenant-isolated staff hosts and separate public `order-*` storefront hosts;
- guest or customer-account ordering, pickup/table QR locations, current menu
  availability, accepted-order reservations, preparation states and atomic
  pay-at-counter tendering;
- workspace-scoped loyalty earning and marketing-consent events;
- POS sales, quotes, invoices, invoice payments, expenses and cash-book data;
- product/variant stock deduction and an independent count/weight/volume stock
  ledger with package conversion, suppliers, expenses, wastage and camera/USB
  barcode scanning;
- daily/weekly/monthly financial reports and workspace consolidation.

The material gaps are delivery, online payments/refunds/settlements, marketplace
channel adapters, promotions and redemption, student verification, ingredient
recipes, purchasing/lots/cost valuation, multidimensional analytics, scheduled
reports and forecasting.

A live read-only check on 9 October found zero storefront settings and zero
active storefront hosts in both `myfin_dev` and `myfin_prod`. The ordering code
and migration are deployed, but no public shop is currently published. Publishing
the first shop is therefore a configuration/privacy acceptance task, not a new
ordering implementation.

## Target architecture

```text
Staff POS / back office        Public shop / customer account
           |                                |
           +---------- MyFin API -----------+
                          |
       +------------------+-------------------+
       |                  |                   |
 PostgreSQL ledgers   pricing/rules       job outbox
 sales, orders,       promotions,         reports, sync,
 payments, stock      loyalty, student    notifications
       |                                      |
       +------- adapter boundary -------------+
               |                        |
       commerce channels           payment providers
       (Gokoo candidate)       (separately selected acquirer)
```

### Payment and reconciliation

Two interfaces are required:

- `CommerceChannelAdapter`: authorize merchant, pull/push menu and availability,
  receive orders, change fulfilment state and import channel financial details.
- `PaymentProviderAdapter`: create/check/cancel an intent, refund, verify a
  callback and list settlements.

Both write an append-only provider-event inbox and canonical payment ledger.
Customer collection, provider receivable, provider fees/tax, refunds and bank
payout are distinct events. A customer-paid marketplace order is not bank cash
until settlement is confirmed. Provider credentials stay in protected files or
secret storage; PostgreSQL stores a credential reference only.

The first Gokoo release is read-only shadow reconciliation in development. It
must prove merchant binding, token refresh, duplicate and out-of-order callback
handling, currency/cent mapping, refund mapping and gross-to-net reconciliation
before it may create a MyFin order or change stock. Catalog/stock write-back is
the final enablement step. See `GOCO_GOKOO_INTEGRATION_ASSESSMENT.md`.

Bank Negara Malaysia says a party providing merchant-acquiring services must be
registered. MyFin should therefore integrate a contracted acquirer and avoid
holding itself out as the acquirer. See [BNM's merchant-acquiring policy](https://www.bnm.gov.my/-/pd-merchant-acquiring-services)
and [approval/registration guidance](https://www.bnm.gov.my/application-for-approval-and-registration).

### Ordering, promotions and student programme

The existing customer-order lifecycle remains the base. Planned additions are:

1. company outlets and service locations;
2. service hours, capacity/lead times and pickup slots;
3. delivery zones, server-calculated fee and short-lived address snapshots;
4. versioned promotion rules and benefits;
5. voucher digests, hints, expiry, caps and append-only redemption events;
6. loyalty redemption and refund/reversal events;
7. expiring student eligibility and student-only promotion audiences;
8. provider payment intents, then refund and settlement recovery.

Marketing consent remains separate from service messages. The Malaysian data
protection authority describes notice, purpose/disclosure, security, retention,
integrity and access as separate personal-data principles. Student and delivery
data therefore need explicit purpose, access and retention controls. See the
[official principles](https://www.pdp.gov.my/ppdpv1/en/principles-of-personal-data-protection/)
and [privacy-notice guidance](https://www.pdp.gov.my/ppdpv1/en/akta/guidance-on-the-preparation-of-personal-data-protection-notices/).

### Inventory and purchasing

The first implementation connects sellable products to ingredients with an
opt-in, versioned recipe. A sale aggregates every component, locks stock items in
stable order, checks availability, and writes exactly-once immutable consumption
rows in the same database transaction. Existing products do not change until a
recipe is deliberately enabled. Quotes never consume stock; later, invoices use
an explicit fulfilment event rather than issue or payment time.

The next inventory release adds a common identifier directory, purchase orders,
partial goods receipts, supplier prices, batches/expiry, weighted-average cost,
reason-coded wastage and low-stock alert lifecycle. Manufacturer GTINs stay
separate from MyFin SKU/internal codes. GS1 defines a GTIN as the identifier for
a trade item, while richer GS1 symbols can also carry lot and date attributes;
the code is a lookup key, not a complete product record. See [GS1 GTIN](https://www.gs1.org/standards/id-keys/gtin),
[GS1 barcodes](https://www.gs1.org/standards/barcodes) and
[GS1 Digital Link](https://www.gs1.org/standards/gs1-digital-link).

### Analytics and reporting

The delivery order is:

1. filtered sales/cash analytics by channel, payment method and product
   category while preserving current report definitions;
2. outlet and customer dimensions;
3. payment reconciliation and order-funnel metrics;
4. inventory, wastage and product performance;
5. cost coverage, COGS and gross margin for owners only;
6. student participation/discount/campaign cohorts with small-cohort suppression;
7. saved report definitions and in-app scheduled results;
8. email delivery through a reviewed SMTP contract;
9. transparent demand forecasting after sufficient history exists.

Forecasting begins with weekday/seasonal baselines, an as-of timestamp,
confidence range and measured WAPE/MAE. It advises purchasing and never places
an order automatically in the first release.

## Live hosting assessment

A read-only sample was taken at approximately **03:34 MYT on 9 October 2026**.
It is a point-in-time capacity observation, not a load test.

| Component | Observation |
| --- | --- |
| `nexus-pbund` | 8 GiB RAM, about 7.8 GiB available; 40 GiB root, 23 GiB available; load 0.03/0.01/0.00 |
| `nexus-docker` | about 11.6 GiB RAM, 10 GiB available; 79 GiB root, 26 GiB available; `/srv/docker` 295 GiB with 278 GiB available; load 0.14/0.15/0.10 |
| MyFin production | API healthy at about 88 MiB of its 512 MiB limit; web healthy at about 2.5 MiB of its 128 MiB limit |
| MyFin development | API healthy at about 74 MiB of its 512 MiB limit; web healthy at about 2.5 MiB of its 128 MiB limit |
| Shared PostgreSQL | about 200 MiB resident; `max_connections=100`; 18 sessions, one active; `myfin_prod` 14 MiB and `myfin_dev` 11 MiB |
| Database recovery settings | `archive_mode=off`, PostgreSQL `ssl=off` inside the current trusted data network |
| Docker storage | 46.82 GB images and 36.99 GB build cache reported; root filesystem headroom must be watched even though `/srv/docker` has ample space |
| Cloudflare ingress | one `cloudflared` process on `nexus-pbund`, active with zero service restarts since 5 September; no second origin replica observed |
| Release backups | recent manual production and development checkpoints exist; no MyFin backup systemd timer was observed on `nexus-docker` |

Current resources are adequate for the next development slice and a modest
single-node production workload. They do not establish throughput for online
ordering, large reports or concurrent integration jobs. Before enabling public
campaigns or provider callbacks, measure menu, quote, order, tender and one-year
report latency under representative concurrency, plus PostgreSQL pool, locks,
I/O and container memory.

The current topology remains appropriate:

- `nexus-pbund`: canonical source/controller and Cloudflare tunnel;
- `nexus-docker`: isolated MyFin web/API containers and the shared PostgreSQL;
- `temp-mailserver`: Mailcow only, reached through a future reviewed SMTP
  contract and never used as MyFin compute or storage.

The main production risks are recovery and single failure domains. Set an agreed
RPO/RTO, automate encrypted off-host backups of database/uploads/config, and run
scheduled restore drills. PostgreSQL's documented PITR design combines a base
backup with a continuous WAL archive; enabling it changes the shared database
platform and must be coordinated and tested for every tenant database. See the
[PostgreSQL 16 PITR documentation](https://www.postgresql.org/docs/16/continuous-archiving.html).
Cloudflare supports additional `cloudflared` replicas for origin failover; a
second replica on a separate host is the appropriate ingress follow-up. See
[Cloudflare Tunnel high availability](https://developers.cloudflare.com/tunnel/configuration/).

## Execution programme

| Release | Deliverable | Promotion gate |
| --- | --- | --- |
| E1 | filtered financial analytics; inventory recipe bridge; disabled integration/reconciliation foundation; architecture and live-capacity record | full tests/build, migration review, development backup/restore and browser acceptance |
| E2 | recipe-based POS/customer-order consumption and reversal; common identifier directory; low-stock workflow | legacy/recipe shadow reconciliation, concurrency/idempotency tests, opening-count approval |
| E3 | outlets, pricing engine, promotions/vouchers, loyalty redemption and student eligibility | pricing parity, discount caps, expiry/refund tests, privacy review |
| E4 | analytics facts/backfill, outlet/customer/payment/inventory/student views and exports | exact-cent/source reconciliation and permission tests |
| E5 | report worker, schedules, in-app delivery and baseline forecasts | dedupe/retry/access-revocation tests and measured forecast accuracy |
| E6 | delivery zones/slots and selected payment-provider intents/refunds/settlements | acquirer contract, hosted payment flow, signed webhook vectors and settlement reconciliation |
| E7 | Gokoo order intake, then menu/stock write-back | vendor identity confirmed, sandbox finance parity, timeout/retry and stale-write tests |

Every release follows `develop -> staging -> main`, uses additive migrations,
backs up before migration, proves restore separately, deploys exact image IDs,
and retains the previous application image for rollback. Schema additions remain
backward compatible so application rollback is possible without destructive
down-migrations.

## Acceptance measures

- No duplicate sale, payment, stock or voucher effect under retry/concurrency.
- Opening stock plus immutable deltas equals the displayed balance.
- Filtered report totals equal their included detail rows to the cent and the
  unfiltered report stays identical to the accepted baseline.
- Quotes never count as revenue and never deduct inventory.
- Marketplace customer payment, provider receivable, fees and bank settlement
  remain separately reconcilable.
- Cross-workspace customer login never merges loyalty, consent or eligibility.
- Operator responses contain no provider secrets, cost, margin or verification
  evidence outside their role.
- Student and delivery records have explicit purpose, retention and deletion or
  redaction behaviour.
- Backups have fresh checksums and a successful isolated restore receipt.
- Production promotion occurs only from the reviewed commit and exact tested
  images.
