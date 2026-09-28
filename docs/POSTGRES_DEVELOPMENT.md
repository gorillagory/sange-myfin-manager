# PostgreSQL development build — Phase 02

This is an independently authenticated development build of the existing Vue app. It has been exercised with synthetic records in a disposable PostgreSQL 16 container and an isolated web/API pair. It is **not deployed to the persistent MyFin development database or a public hostname**, and does not import or retire Firebase production. The final Phase 02 packet report is authoritative for exact executed tests and cleanup status.

## Source and runtime

Continue from the full dirty canonical workspace on nexus-pbund, not just Git HEAD. No commit or push was made. The pre-job full source snapshot is `/root/myfin-jobs/phase02-postgres-app-20260912/source-before.tar.gz`, with `source-before.json`. Selected old Firebase adapters and their dependency manifests are preserved in `archive/firebase/`; this is reference source, not a complete independently runnable rollback release. Original Firebase deployment/rules files remain preserved. Do not deploy this new API-dependent frontend through the old Firebase workflow.

Deployment remains app-only `myfin-dev` web + API under `/srv/docker/apps/sange-myfin-manager` on nexus-docker. Canonical source stays on nexus-pbund. Node 24 LTS is used inside the tested Dockerfiles; controller Node 20 is unchanged. The API joins existing `nexus-data` only at a separately reviewed persistent deployment. No other application's identity, database, network, mail or controller service is shared or modified by MyFin code.

## Authentication and authorization

Better Auth **1.7.4**, pinned in `server/package-lock.json`, owns password derivation, session cookies, current-password verification, expiry and revocation. Its PostgreSQL adapter uses dedicated `myfin.auth_*` tables generated from the pinned package schema, in versioned SQL. Startup performs no DDL. The account provisioning helper calls the library's exported `hashPassword`, then creates the credential, application identity and explicit subject mapping in one SQL transaction. It implements no password cryptography or token framework.

Official interfaces inspected during implementation: [Fastify integration](https://better-auth.com/docs/integrations/fastify), [PostgreSQL](https://better-auth.com/docs/adapters/postgresql), [email/password](https://better-auth.com/docs/authentication/email-password), [security](https://better-auth.com/docs/reference/security), [options](https://better-auth.com/docs/reference/options).

- Public registration, reset-email delivery, invitations, social auth and implicit account linking are disabled. The HTTP auth surface only exposes sign-in, sign-out, session retrieval and current-password-verified password changes. Failed auth responses are generic. No emails are sent.
- `AUTH_BASE_URL` must be one exact HTTPS origin, with no credentials, path, query or fragment. `AUTH_SECRET_FILE` is a protected file with at least 32 characters. The sole HTTP exception requires both `NODE_ENV=test` and `AUTH_LOCAL_TEST=true`, with a loopback hostname. It is not part of production Compose.
- Cookies are host-only, HttpOnly, SameSite=Lax and Secure for HTTPS; sessions expire after one day with hourly renewal. Cookie session caching is disabled. Disabled accounts cannot create sessions; disable/delete/role changes revoke existing sessions. Application identity and current membership are checked server-side for business access.
- Every mutation, including auth and file uploads, requires an exact `Origin`; missing origins and cross-site Fetch Metadata are rejected. Fastify trusts no forwarded headers. Better Auth receives the configured origin and sanitized forwarding headers. Nginx recognizes the original HTTPS scheme only from the reviewed tunnel controller address `.103`; authentication derives security from configured external origin, never that header.
- Global super is an explicit application flag, with no migration-seeded super. Company users cannot create users, grant privileges, change company settings or delete business records. Catalog creation/update/import remains available to store staff, matching the existing UI and original rules. Company admins cannot manage another company's users or grant global super. A non-global identity has one company membership, matching the existing UI. Historical Firebase UIDs belong in explicit `identity_mappings` rows; matching an email never links identities.
- User deletion is access revocation with retained historical identity. Company deletion archives it, hides it from normal hydration and revokes staff access while retaining financial records and files. Restoring archived access is an operator task, not an implicit migration.
- Rate limits apply even in tests: global API limit 300/minute, auth route 60/minute, sign-in 10/minute, upload route 20/minute. Limits currently aggregate behind the web proxy because forwarded client IPs are deliberately untrusted. Review capacity before multiple tills or API replicas; memory rate limits are per process.

Production invitation/reset delivery remains gated on a separately configured and tested SMTP transport. Administrator-created development accounts and the synthetic CLI are functional. The seed CLI requires `MYFIN_ALLOW_DEV_SEED=true`, database `myfin_dev`, a synthetic `.test` email and a password file; it refuses `NODE_ENV=production` and creates no default password.

## Business API and database

`/api/me`, `/api/companies`, `/api/users`, and explicit `/api/companies/:id/{products,clients,transactions,expenses,activities,stock_movements}` adapters retain the Vue store method surface. Lists use bounded keyset pagination (`limit <= 500`, optional `after`); unknown filters are rejected. The device hydration ceiling is 50,000 records per collection and fails visibly rather than silently truncating. Mutations use strict schemas, including nested product variants, preferences and sale items. JSON request bodies are capped at 2 MiB.

Company and identity ownership are typed SQL columns and foreign keys. Stock uses numeric columns with three decimal places, including variants; money has bounded numeric columns. JSONB retains compatible document fields and receipt snapshots. Versioned migrations enforce memberships, quote conversion links and posted POS immutability. Migration 0008 preserves the original project-only grouping operation for posted receipts; the database rejects changes to every other receipt column or JSON field, and checkout replay retains the original fingerprint. The runtime role has explicit table permissions, append-only audit/movement writes, no schema creation, no migration-ledger mutation and no owner membership. The operator grants only MyFin privileges after migrations.

Checkout validates the existing shared rounding functions, fractional quantities, tender and receipt identity. A transaction-scoped receipt lock precedes stable product-row locking. A full canonical request fingerprint rejects changed retries, including customer, tax, discount, date, offline flags and receipt snapshots. The server supplies actor/cashier identity and commits receipt, stock, customer email, movement history and audit together. A replay after a lost response returns the original committed receipt. Offline paid receipts can create flagged stock shortages; service products never deduct stock. Product create/update/import records opening stock and adjustments. Product edits carry a server version; stale editors cannot overwrite concurrent POS stock deductions. Price overrides in captured offline sale lines remain the existing domain behavior; checkout does not reprice already collected payments against a later catalog.

Generic finance endpoints cannot write POS source/actor fields, reuse a POS number, change a posted POS receipt, or forge conversion metadata. Quote conversion and project assignment are atomic. Converted quote/invoice links prevent deletion that would break conversion history. Customer deletion retains original receipt snapshots; manual records remain separately classified from POS.

## Offline behavior and files

The active frontend has no Firebase dependency, initialization, imports or credential build arguments. API hydration replaces listeners with immediate clearing on user/company changes, generation guards against stale responses, mutation refresh and 30-second reconciliation. Reconnection refreshes the catalog and retries the durable outbox.

IndexedDB `myfin-pos` upgrades from version 1 to 2 without deleting existing drafts/outbox. Catalog snapshots are explicitly partitioned by application user and company. Paid receipts survive logout, expiry, failed requests and reload; the original stable sale ID is replayed. Failed server sign-out is retained as a local revocation retry and cannot silently reopen the cached workspace. Optional localStorage failure does not prevent online login, while failed IndexedDB transactions prevent checkout from claiming a durable payment save. Cache errors are shown explicitly.

**Origin transition gate:** browser IndexedDB is origin-bound. Inventory every till's old Firebase-origin outbox; drain it against the original system or export and explicitly reconcile each paid receipt before changing origin. Do not purge old-origin storage, merge users by email, blindly repost already paid historical receipts, or automatically reinterpret old UID ownership. Server-side account/UID mapping and operator-reviewed import tooling remain future migration work.

The worker caches application assets only. It never intercepts `/api`, `/api/*` or private file navigations, and cannot turn their failures into the SPA shell. Authenticated product photos are not available offline unless already held in the current page's memory; the catalog and selling workflows work without photos.

Private upload bytes are stored only under `/app/uploads`, using server-generated names, exclusive no-follow writes and mode 0600; the directory/volume is UID 1000, mode 0700. Metadata is tenant-scoped in PostgreSQL. Reads authenticate and authorize, reject symlinks/nonregular files, and send no-store, nosniff and restricted content headers. PDFs download as attachments. Byte-based type recognition accepts JPEG/PNG/WebP and receipt PDFs; products are limited to 3 MiB, receipts to 5 MiB. The web body limit is 6 MiB to allow multipart overhead. Web has no upload volume and serves no public upload directory.

File references must belong to the same tenant. Referenced files cannot be deleted; detach or replace them first. This includes company logo and QR references as well as product/receipt references. Same-company staff may remove unreferenced files, matching the original storage rules. A filesystem write is flushed before metadata is committed. On a definite metadata failure the newly written file is removed; a failed response after commit leaves the committed file intact. Crashes or abandoned editors can leave inaccessible/unreferenced objects; reconcile them against metadata and references during reviewed maintenance rather than deleting files by age. No image-processing or mail service is introduced.

## Development deployment review

Review `deploy/development.env.example`, then place the real environment and secret files outside Git. Candidate external origin is `https://myfin-dev.bayam.live`; the supervising task must confirm hostname ownership, access policy and the unused `.100:8083` bind before assigning it. The job used loopback test port 28083 and did not reserve 8083 or alter DNS/tunnels.

The scripts under `scripts/deploy/` are deliberately fixed to `myfin-dev`, `myfin_dev`, `myfin_dev_runtime`, `myfin-dev-uploads` and `nexus-shared-postgres`. Do not use them for production or rename them to bypass scope checks. They do not change the shared Compose stack, PG configuration/HBA, shared network, SMTP or other databases. Run from the reviewed source artifact on nexus-docker, after sourcing the reviewed protected environment:

```sh
export MYFIN_RUNTIME_ENV=/absolute/protected/myfin-development.env
# Generate a NEW protected directory, then fill the reviewed env with file paths.
python3 scripts/deploy/create-secrets.py /absolute/new/private-directory
scripts/deploy/build.sh
MYFIN_REVIEWED_DEV_PROVISION=myfin_dev scripts/deploy/provision.sh
scripts/deploy/migrate.sh
# MYFIN_SEED_PASSWORD_FILE and MYFIN_SEED_EMAIL must be explicitly set.
scripts/deploy/seed.sh
MYFIN_REVIEWED_DEV_DEPLOYMENT=myfin-dev scripts/deploy/up.sh
scripts/deploy/smoke.sh
```

The provisioning script fails on existing database/role/volume names. A partially completed provisioning attempt must be inspected, not rerun destructively. The chosen PostgreSQL administrator role must be supplied through the existing operator mechanism; these scripts do not discover or read platform credentials. The build is sequential and the long-lived API receives only runtime and auth secrets. Migrator credentials are used by a one-off migration command. The upload initialization helper changes ownership only on the explicitly named MyFin volume.

Compose fixes web at 128 MiB/0.25 CPU and API at 512 MiB/1 CPU by default, uses nonroot users, read-only root filesystems, bounded tmpfs, dropped capabilities, health checks and a 15-second graceful stop. API and PostgreSQL publish no ports in the deployment template. Web alone publishes the explicit bind. Record immutable image digests for the reviewed release and its rollback artifact; base tags are maintained upstream, not a permanent release pin.

## Recovery and acceptance commands

`backup.sh` stops only MyFin API, saves a PostgreSQL custom dump and private-file tar as a matched quiescent pair, writes SHA-256 checksums, and restarts that API. Supply a new absolute `MYFIN_BACKUP_DIR`. Coordinate with all operator writers during the backup window. The dump contains identity/session material: preserve mode 0600 in a mode 0700 directory, add reviewed off-host retention/encryption, and never commit it.

`restore.sh` requires `MYFIN_REVIEWED_EMPTY_DEV_RESTORE=myfin_dev`, an empty MyFin schema and empty upload volume. It never drops an existing database. It validates checksums, restores files and uses transactional `pg_restore` under the owner role, preserving the pre-provisioned schema namespace. The API stays stopped for migration/checksum, file-reference and smoke verification. It deliberately does not auto-cut over or overwrite live data. Restore files are trusted backups produced by this app-specific process, not arbitrary user-supplied tar archives.

Local checks:

```sh
npm ci
npm ci --prefix server
npm test
npm test --prefix server
npm run build
npm run test:offline
git diff --check
```

The opt-in `server/test/postgres-acceptance.mjs` refuses all targets except the job tunnel `127.0.0.1:25432`, `myfin_dev`, with `MYFIN_ISOLATED_ACCEPTANCE=myfin-phase02-pg-20260912`. It creates synthetic fixtures; never aim it at the shared PG or persistent development data. The packet contains its exact invocation, protected test inputs, build logs, Chromium artifacts and resource lifecycle evidence. `tests/browser-acceptance.mjs` runs against the isolated local-test app with Playwright 1.63.0 installed separately; it reads a mounted synthetic password file and does not record traces or credential-bearing requests.

Development review should repeat HTTPS cookie/origin tests, verify admin/staff roles, create a company/product/variant/customer/invoice/quote/expense, exercise concurrent and offline checkout, reload and recover paid queues, test private files, and confirm printable PDFs on the user's devices. Physical printer behavior, external card/QR settlement, mail-client sending, SMTP delivery, production import/reconciliation, off-host restore and human browser confirmation are separate gates.

For an explicitly isolated local UI development profile, Vite binds only `127.0.0.1:5173` and proxies `/api` to `127.0.0.1:18080`. Start the API with protected PostgreSQL inputs, `PORT=18080`, `NODE_ENV=test`, `AUTH_LOCAL_TEST=true`, and `AUTH_BASE_URL=http://localhost:5173`; browse that exact localhost origin. The default production configuration never enables this exception. Do not publish the Vite server or reuse the isolated test profile on an external hostname.


### Explicit SSH-only browser acceptance fallback

The supervisor's read-only checkpoint found no DNS record for the candidate hostname and no signed-in Cloudflare management session. Publication remains a separate prerequisite. For reviewed development acceptance before public HTTPS, `deploy/local-acceptance.override.yml` sets **only the API** to the exact local test origin `http://localhost:18083`, with `NODE_ENV=test` and `AUTH_LOCAL_TEST=true`. Keep the reviewed `.100:8083` web bind in the protected environment. After provisioning/migration review, the supervisor may run:

```sh
docker compose --env-file "$MYFIN_RUNTIME_ENV" -p myfin-dev -f deploy/compose.yml -f deploy/local-acceptance.override.yml config --quiet
docker compose --env-file "$MYFIN_RUNTIME_ENV" -p myfin-dev -f deploy/compose.yml -f deploy/local-acceptance.override.yml up -d --no-build
# On the user's computer, through its existing SSH access:
ssh -N -L 18083:192.168.1.100:8083 nexus-pbund
# Browse exactly http://localhost:18083
```

This override is excluded from the standard deployment scripts. Never use it with a public origin; remove the override and recreate the API with the reviewed exact HTTPS origin before external acceptance. Localhost is a browser secure context for service workers, while cookies deliberately lack Secure only in this explicit local test mode. The source job did not execute this persistent deployment or change tunnel configuration.
