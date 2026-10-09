# MyFin platform expansion release readiness

**Status:** development deployed and operationally verified at exact application
source `4b3095f38f27f71c5dd1e950474efbf660bcfcc3`; authenticated browser
acceptance pending

**Development application:** `4b3095f38f27f71c5dd1e950474efbf660bcfcc3`,
migrations through `0028`

**Production application:** `6e08462ddbe3a8f2668e9325946ac69b0a53b3bf`,
migrations through `0019`

**Development/promotion source:** `4b3095f38f27f71c5dd1e950474efbf660bcfcc3`
on `develop`

## Release contents

| Migration | Module delivered in source |
| --- | --- |
| `0020` | Opt-in versioned inventory recipes and immutable consumption evidence |
| `0021` | Disabled provider-neutral commerce/payment integration and reconciliation evidence |
| `0022` | Student eligibility, versioned promotions, vouchers and exact-sen pricing foundation |
| `0023` | Identifier directory, suppliers, purchasing, partial receipts, batches/cost and low-stock workflow |
| `0024` | Scheduled in-app reports, snapshots and advisory forecasts |
| `0025` | Opt-in delivery zones, signed address/zone binding and retention fields |
| `0026` | Read-only normalized payment-operations evidence |
| `0027` | Storefront promotion/voucher quote and reservation lifecycle |
| `0028` | Version-bound customer-order recipe reservations, stock floor and offline recipe-boundary review |

The application also includes dynamic financial/operational/customer/student/
inventory analytics, migrated-document accounting normalization, public
pickup/table/delivery ordering, exact delivery-fee settlement, student and
procurement administration, report-worker lease fencing and scheduled customer
order privacy cleanup.

Gokoo remains a disabled candidate commerce adapter. No external payment
provider, payment intent, refund, settlement, webhook or catalog/stock write is
enabled by this release. Public ordering remains pay at counter.

## Verification evidence

| Check | Evidence | Scope limit |
| --- | --- | --- |
| Server suite at exact deployed SHA | 201/201 passed | Source test, including full authenticated Fastify route registration |
| Frontend suite at exact `0028` SHA | 66/66 passed | Source test, not browser acceptance |
| Offline and management suites | 11/11 and 7/7 passed | Source test, not device/browser acceptance |
| Recipe-focused server/frontend suites | 21/21 and 22/22 passed | Includes late review and replay evidence cases |
| Receipt/PDF/POS/customer-order focused tests | 27/27 passed | Source test, not browser acceptance |
| Production build at exact `0028` source | Passed; 57 offline assets | The deployment receipt below records images built on `nexus-docker` |
| Promotion database acceptance | Disposable PostgreSQL 16.14 passed concurrency, lifecycle, rollback, replay and immutability checks through `0027` | No live database was changed |
| Recipe-order migration | Disposable PostgreSQL 16 applied `0001` through `0028` | No live database was changed |
| Recipe-order adversarial acceptance | 8/8 passed on PostgreSQL 16.13 | Disposable database/container/volume removed after the run |

The 8/8 recipe-order scenarios prove:

1. concurrent accepted orders serialize a shared-ingredient hold and prevent
   oversell;
2. a held recipe version survives later edits, and tender/retry remains
   exact-once;
3. a forced failure after inventory work rolls back stock and reservation state
   together;
4. cancellation and scheduled expiry release active ingredient holds;
5. online tender trusts server time while an offline recipe-version boundary
   requires an explicit manager resolution;
6. the database blocks archive, count, waste and procurement-related decrements
   below a live hold;
7. count-tracked ingredients validate every component reservation line rather
   than accepting a fractional line whose cart aggregate happens to be whole;
   and
8. a review that becomes recipe-ambiguous while pending preserves its original
   cause, requires an explicit manager choice and cannot record a choice that
   differs from an already-posted sale.

The exact-SHA checks were:

```text
npm --prefix server test
npm test
npm run test:offline
npm run test:management
npm run build
git diff --check
```

## Development deployment gates

- [x] Commit the complete code candidate and record its SHA.
- [x] Run and record every exact-SHA command above.
- [x] Confirm `develop`, `staging` and `main` heads before any update; promote
      the reviewed SHA rather than copying an uncommitted workspace.
- [x] Create or verify the development voucher HMAC secret outside Git with
      owner-only permissions and configure `MYFIN_VOUCHER_HMAC_SECRET_FILE`.
- [x] Take a fresh development database/config/uploads backup, copy its checksum
      off the runtime host and complete an isolated restore rehearsal.
- [x] Apply migrations `0020` through `0028` and the development runtime grants;
      verify the schema ledger reports `0028` exactly once.
- [x] Build API, web and report-worker images sequentially on `nexus-docker` and
      record exact image IDs to avoid storage/RAM pressure.
- [x] Start API, web and report worker; verify health, migration state, worker
      lease/retry behaviour and redacted logs.
- [x] Run unauthenticated host/menu/quote safety smokes and authenticated role,
      accounting, inventory and analytics smokes.
- [ ] Complete browser acceptance at `https://dev-pos.bayam.live` with a real
      workspace account. Do not handle or record the user's password.

Development acceptance must cover at least:

- migrated Firebase sales and invoice payments contribute to financial analysis;
- quote -> invoice -> payment and a manual non-POS sale/cash flow use the agreed
  accounting events;
- owner, manager and operator visibility matches role rules, including
  owner-only cost/margin and student eligibility mutation;
- public quote, promotion/voucher reservation, cancellation/expiry and
  exact-once counter tender;
- delivery minimum/fee, receipt/PDF/report presentation and terminal PII
  redaction;
- recipe-backed shared-ingredient availability, accepted-order hold, tender,
  cancel and expiry;
- purchasing/partial receipt, identifier scan, low-stock state and stock-floor
  error presentation;
- scheduled report creation/result access and advanced analytics filters.

Do not publish a new storefront host, enable a production promotion or activate
an integration merely to perform development acceptance. Use reviewed test data
and preserve existing live settings.

## Production promotion gates

- [ ] Development browser acceptance is signed against the exact candidate SHA
      and image IDs.
- [ ] The same SHA passes staging smoke/acceptance; no rebuild from different
      source is substituted.
- [ ] A distinct production voucher HMAC secret exists outside Git with
      owner-only permissions.
- [ ] Take a fresh production backup, store an off-host checksum and prove an
      isolated restore before migration.
- [ ] Record current image IDs, container configuration, migration ledger,
      Cloudflare routes and rollback commands.
- [ ] Apply additive migrations and grants, then deploy API/report worker/web in
      the documented order with health checks between steps.
- [ ] Reconcile production row counts and selected exact-sen totals before and
      after migration. Migration must not create sales, stock, payment or
      promotion effects.
- [ ] Run authenticated production smoke with non-destructive checks, followed
      by DNS/TLS/tenant-host verification.
- [ ] Promote the exact accepted SHA through `staging` to `main`; record release
      commit, image IDs, backup receipt and acceptance owner.

## Topology and recovery risks

| Risk | Current condition | Required control |
| --- | --- | --- |
| Database point-in-time recovery | Shared PostgreSQL reported `archive_mode=off` | Define RPO/RTO; add coordinated base backups plus WAL archive; rehearse restore for every tenant database |
| Backup freshness | Manual MyFin checkpoints existed; no automated MyFin timer was observed | Automated encrypted off-host database/uploads/config backup, checksum verification and scheduled restore drills |
| Ingress failure domain | One `cloudflared` process on `nexus-pbund` | Add a second replica on a separate host and test origin failover |
| Runtime failure domain | MyFin and shared PostgreSQL run on `nexus-docker` | Monitor host/storage/pool/locks; document host recovery; load-test public ordering and reports |
| Root storage | Docker images/build cache consume root capacity while `/srv/docker` has headroom | Build sequentially, prune only reviewed disposable cache and alert on root usage |
| Mail dependency | `temp-mailserver` is Mailcow only | Keep it out of application compute/storage; add SMTP only through a reviewed secret, retry and privacy contract |
| Provider exposure | Gokoo identity/signature/payment semantics are incomplete; no acquirer selected | Keep all provider connections disabled until commercial, security, sandbox, accounting and settlement gates pass |

## Rollback expectations

1. Preserve migrations and evidence. Do not run destructive down-migrations or
   delete immutable order, pricing, payment, recipe or stock rows.
2. Keep the previous API/web/report-worker images and their configuration. An
   application rollback must use recorded image IDs, then repeat health and
   tenant-host smoke checks.
3. Stop new public-order acceptance and the report worker before rollback if
   the failing component can create new effects. Let an in-flight transaction
   commit or roll back; do not edit it manually.
4. Migration `0028` is additive, but an older application cannot manage active
   recipe-order holds. If any such hold exists, roll forward to a fixed
   reservation-aware image or suspend recipe-backed public ordering and resolve
   affected orders through a reviewed procedure. Do not silently run the
   `0019` application against active `0028` holds.
5. Database restore is a disaster-recovery action, not the normal application
   rollback. If required, restore into isolation first, confirm timestamp and
   checksums, reconcile post-backup sales/payments/orders, and obtain an explicit
   cutover decision.
6. Provider and storefront feature gates remain disabled during rollback.
   Never compensate by deleting ledger rows; use supported reversal, refund,
   cancellation or release events.

## Acceptance record

### Development deployment receipt

- Deployed at `2026-10-09T08:54:10Z` from application source
  `4b3095f38f27f71c5dd1e950474efbf660bcfcc3`.
- Immutable source snapshot:
  `/srv/docker/releases/sange-myfin-manager/4b3095f`; active application link:
  `/srv/docker/apps/sange-myfin-manager`.
- Protected active runtime:
  `/srv/docker/secrets/myfin-dev/runtime.env`; versioned candidate runtime:
  `/srv/docker/secrets/myfin-dev/runtime-platform-4b3095f.env`.
- API and report worker: `myfin-api:platform-4b3095f`, immutable image ID
  `sha256:53475ac03cb84e0cf9d58de75810c5b5bc1899d8ae29b903c9701ca08143d940`.
- Web: `myfin-web:platform-4b3095f`, immutable image ID
  `sha256:4fe572466cdd023f67b8b226f8fa7d3f83dc7510a84e90725e9ea70c4d6445f7`.
- Previous application snapshot: `/srv/docker/releases/sange-myfin-manager/6e08462`;
  previous protected runtime copy:
  `/srv/docker/secrets/myfin-dev/runtime-before-platform-4b3095f.env`. The old
  runtime must be paired with the old release's compose definition because the
  new compose file requires the voucher secret entry.
- Pre-migration backup:
  `/srv/docker/backups/myfin-dev/pre-platform-b51c80d-20261009T074849Z`;
  checksum-verified off-host copy:
  `/root/myfin-recovery/dev-20261009/pre-platform-b51c80d-20261009T074849Z`
  on `nexus-pbund`.
- Backup checksums: database
  `eef0e5ec5a85fb93859447c20e28f2d634369a95eb90fe3ac34a977745993182`;
  uploads
  `3443380c80fa40735cdbac737866d83eeece63d486ac73723f7ac8935e0539a6`.
- The protected runtime and voucher-signing secret are also mirrored under the
  `config` subdirectory on both hosts with directory mode `0700` and file mode
  `0600`. Their independent checksums are
  `ae43768ed52114bc50b96243ce5e8f13249c9cb454f46efa66ef67e2c07619c7`
  and
  `b2bb187f174b1462ccbb62acac88e34237237bf6ac3169b029f34c5921f50c2f`;
  no secret value is stored in this receipt.
- Isolated restore rehearsal reconciled `19` migrations, `2` companies, `47`
  products, `5` transactions and `0` expenses before the expansion migration.
  `RESTORE_REHEARSAL_RECEIPT.txt` is present beside both backup copies with
  checksum
  `95abdd4772c13bc2ea94a42bcaeeba1366798ae96349791db2c72c6d17cb0636`.
- The live development ledger reports `28` migrations through
  `0028_recipe_order_integrity.sql`, with `0028` present exactly once. A repeat
  migration run applied `0` migrations and re-applied only explicit grants.
- API and web are healthy, the report worker is running, all three containers
  have zero restarts, and the worker has no expired leases or claimable failed
  runs. Startup and worker logs contain no duplicate-route, pool or cycle-failure
  marker.
- LAN and public HTTPS unauthenticated smoke passed. Authenticated public
  operations and feature smoke passed as SuperAdmin; financial summary, detail
  and consolidation totals reconcile. The login and six-digit POS access pages
  also render correctly in Chrome. Authenticated browser workflow acceptance is
  still pending.

| Stage | SHA / image IDs | Database | Evidence | Result / owner |
| --- | --- | --- | --- | --- |
| Source candidate | `4b3095f38f27f71c5dd1e950474efbf660bcfcc3` | Disposable PG16 `0001`-`0028` | Server 201/201; frontend 66/66; offline 11/11; management 7/7; recipe adversarial 8/8; production build | Source-tested |
| Development | `4b3095f38f27f71c5dd1e950474efbf660bcfcc3`; API/worker `myfin-api:platform-4b3095f` / `sha256:53475ac0...`; web `myfin-web:platform-4b3095f` / `sha256:4fe57246...` | `myfin_dev`; 28 migrations through `0028`; repeat applied zero | Checksum-verified local/off-host backup; isolated restore; LAN/public/authenticated smokes; browser login and POS-code surfaces | Deployed and automated checks passed `2026-10-09T09:28:37Z`; authenticated browser acceptance pending |
| Staging | _pending_ | _pending_ | Exact-image smoke and reconciliation | Not started |
| Production | Live `6e08462` | Live through `0019` | Existing health baseline only | Expansion not deployed |

No row above should be changed to accepted without the referenced command,
receipt or human browser decision. This document is the release checklist; it
is not itself evidence that deployment occurred.
