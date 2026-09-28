# MyFin backend foundation — Phase 01

> Phase 02 update: this document retains the historical foundation/plan. The implemented PostgreSQL development build and current deployment gates are documented in [POSTGRES_DEVELOPMENT.md](POSTGRES_DEVELOPMENT.md) and the Phase 02 packet result.


Source foundation completed on 12 September 2026 in `/root/workspaces/sange-myfin-manager`. This is an undeployed development API and web packaging foundation. The current Vue frontend still uses Firebase Auth, Firestore, Storage, subscriptions and Firestore's offline cache. Building or deploying these containers does not replace those integrations. No PostgreSQL objects, roles, volumes, containers or ingress routes were created by this phase.

## Decisions and boundaries

- Standalone MyFin application identities are the default. Sharing Nexus PostgreSQL does not share Sange identities, tables or privileges. A later phase will vet a maintained PostgreSQL-backed authentication integration (Better Auth remains a candidate), including sessions, password reset, CSRF, trusted origins and authorization. Public registration stays disabled: this API has no registration, login, session or business routes. There is no fake authentication, default administrator or seeded user.
- Preserve opaque historical company/document IDs and Firebase UIDs as text. `app_identities.id` can retain the Firebase UID; `identity_mappings(provider, subject)` records its namespaced source such as `firebase:<project-id>`. Preserve the authoritative original export and UID/profile reconciliation evidence. Never join identities by email alone; provider subjects are unique within their namespace. Auth-provider credential tables will be separate and mapped explicitly.
- `memberships` joins an identity to a company, with `company_admin` or `company_user`. The composite primary key prevents duplicate membership; foreign keys prevent orphan membership. The model permits multiple companies without rewriting IDs; the current single `company_id` profile becomes one membership. Existing Firebase `super` is a historical global privilege, not a company membership role. Preserve it in reviewed import evidence and decide an explicit audited global-role model before importing elevated privileges. No privilege is inferred or granted in this phase.
- Company isolation is a future API authorization obligation: verify the session identity, check active identity/membership for every selected company, and scope every business query and write to that company. Client-supplied company IDs alone are insufficient. Future child tables need tenant-aware composite foreign keys where IDs could otherwise cross companies. Current SQL has structural constraints, not row-level security or a finished authorization system. The trusted runtime role can read foundation rows across companies; browsers never get SQL credentials or these rows through this API.
- Preserve existing atomic/idempotent checkout, saved receipt snapshots, fractional quantities, variants, inventory movements and durable offline outbox semantics. This phase does not implement CRUD, checkout, frontend adapters, Firebase offline replacement, imports or production migration.
- Files will be private, API-owned persistent storage at `/app/uploads`. There is no upload/download endpoint yet. The web container cannot mount or serve this volume. A later file phase must add tenant checks, size/type validation, safe generated paths, lifecycle rules and database/file backup consistency. SMTP credentials and delivery validation remain later work; existing receipt mailto drafts are not SMTP delivery.

## Packages and runtime

`server/` is a separate Node ESM package with its own exact dependency pins and npm lockfile: Fastify **5.12.4**, `pg` **8.23.0**. Registry metadata was checked during this phase and installs reported no vulnerabilities. Frontend package files and all existing scripts/dependencies are unchanged from the supplied dirty baseline.

Fastify 5 requires Node 20 or newer; the controller's **20.20.2** runs source tests without a system upgrade. Containers use **Node 24 LTS**, `node:24-bookworm-slim`; web serving uses `nginx:stable-alpine`. Tags intentionally receive upstream maintenance updates. A deployment packet must pull, review and record the resolved image digests, then pin approved artifact tags/digests for rollback. Container execution has not been verified here.

Primary references: [Fastify 5 compatibility](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/), [Node release lifecycle](https://nodejs.org/en/about/previous-releases), [official Node images](https://github.com/nodejs/docker-node/blob/main/README.md), [pg pool lifecycle/options](https://node-postgres.com/apis/pool), [pg client timeout options](https://node-postgres.com/apis/client), [official nginx image](https://hub.docker.com/_/nginx). Exact package metadata is reproducible with `npm view fastify@5.12.4 version engines --json` and `npm view pg@8.23.0 version engines --json`.

## API configuration and behavior

No `.env` autoloading occurs. Supply an explicit environment (or Node's `--env-file` for a separately protected local file). Never put backend secrets in `VITE_*`, Docker build arguments, checked-in files or frontend output. Compose mounts a password file only into the API. No complete backend environment file is passed into the web build.

| Variable | Default / contract |
| --- | --- |
| `NODE_ENV` | `development`; also `test` or `production` |
| `HOST`, `PORT` | `127.0.0.1`, `8080`; Compose explicitly binds API to `0.0.0.0` internally |
| `PGHOST`, `PGPORT` | `nexus-shared-postgres`, `5432` |
| `PGDATABASE`, `PGUSER` | `myfin_dev`, `myfin_dev_runtime`; identifier validation enforced |
| `PGPASSWORD` or `PGPASSWORD_FILE` | Exactly one usable secret required; file's final newline removed; no multiline password |
| `PG_TLS` | `disable` on the supplied private development network; alternatively `verify-full` |
| `PG_CA_FILE` | Optional CA file for `verify-full`; no insecure verification mode |
| `PGPOOL_MAX` | 5, range 1–20; provisioning role cap also 5; do not raise one without reviewing both and replica totals |
| `PG_CONNECT_TIMEOUT_MS` | 2000, range 100–10000; also bounds pool checkout wait |
| `PG_STATEMENT_TIMEOUT_MS` | 3000, range 100–60000; server cancellation |
| `PG_QUERY_TIMEOUT_MS` | 4000, range 100–65000 and greater than statement timeout |
| `PG_IDLE_TIMEOUT_MS` | 10000, range 1000–60000 |
| `SHUTDOWN_TIMEOUT_MS` | 10000, range 1000–30000; Compose grace period 15 seconds must exceed this |

Idle transactions time out after 10 seconds. Queries use explicit schema names with `pg_catalog,myfin` search path. `DATABASE_URL`, `PGSSLMODE` and `PGOPTIONS` overrides are rejected to avoid ambiguous settings. TLS on the existing shared server must be validated before changing the development template; mount a trusted CA and enable `verify-full` in a reviewed override when supported. Production transport policy remains separate.

- `GET /api/health/live`: 200 `{ "status": "ok" }`, independent of DB availability.
- `GET /api/health/ready`: 200 only when the foundation migration record and table read permissions are available; otherwise 503 with `database_unavailable`. DB errors and credentials are never returned. Readiness uses one bounded pool query and `Cache-Control: no-store`; it does not claim auth, SMTP, storage or business readiness, or validate every schema property.
- Invalid process configuration fails startup with a redacted message and nonzero exit, so it can never be ready. The injected app factory without a configured DB explicitly returns 503 `configuration_unavailable`.
- Unknown endpoints return JSON 404; unexpected handler errors return fixed JSON 500. Request logging is disabled so query strings/headers are not automatically recorded. Idle pool errors produce a fixed event name.
- SIGINT/SIGTERM drain Fastify requests, then close the pool once. Repeated signals share the same shutdown; overdue or failed shutdown exits nonzero. Readiness is unavailable during closure.

## Database and migrations

The proposed database is `myfin_dev` in existing PostgreSQL 16. Production later uses its own `myfin` database, separately named roles/secrets, upload volume and Compose project. Nothing provisions production automatically.

`db/provision-development.sql` is an **unexecuted operator proposal** for a fresh database. It deliberately fails on name collisions rather than accepting unknown ownership. It creates a NOLOGIN owner, an independent NOINHERIT migration login allowed to SET ROLE to that owner, and an independent restricted runtime login. Runtime is not a member of the owner and cannot create schemas/tables or change migration history. Passwords are set through the operator's secret process; no default password is included. Database PUBLIC access and public-schema access are revoked only within MyFin scope. Shared PostgreSQL login/HBA policy and other databases' PUBLIC privileges must also be reviewed by the operator: these scripts do not alter other applications' ACLs.

Migrations run only through `npm --prefix server run migrate` (or its equivalent Node entry point), with explicit `PGUSER=myfin_dev_migrator` and `MIGRATION_OWNER=myfin_dev_owner`. API startup, npm install, frontend build and Docker build never run migrations. The runner obtains a transaction-scoped advisory lock on a dedicated client, creates a private history table, checks all applied versions and SHA-256 checksums, and applies the pending batch and history inserts in one transaction. A concurrent runner fails immediately with `migration_locked`; retry only after the other job completes. Identical repeated runs apply zero files. Modified checksums, removed/renamed migrations, and insertion before an applied version fail closed. Commit transport failure can leave outcome uncertain; reconnect and rerun unchanged files to reconcile the recorded history, never delete ledger rows.

Migration names are `NNNN_description.sql`, uniquely numbered, ordered and UTF-8. Checksums include line endings. Never edit an applied file; add a later corrective migration. SQL must be transactional and must not contain its own BEGIN/COMMIT, concurrent index creation, or other nontransactional operations. The initial small batch uses the configured statement/query timeouts; review limits for future migrations. On failure the runner rolls back and closes its connection, logging a fixed safe error code rather than SQL/driver details.

After migration, the operator runs `db/grant-development-runtime.sql` in `myfin_dev`. It grants SELECT on the explicit foundation tables/ledger only. No blanket default privileges or runtime writes are granted. Later business phases must introduce reviewed table grants alongside authorization. Provisioning/grant SQL and PostgreSQL transaction/constraint/role behavior remain **unexecuted against real PostgreSQL**; fake clients prove orchestration only.

## App-only deployment contract

`deploy/compose.yml` defines exactly two services. Web serves the built Vue app on container port 8080 and proxies `/api/` to API port 8080. Exact `/api` never hits SPA fallback, upstream API errors pass through, and nginx-generated gateway failures return a fixed JSON 503. Docker DNS is re-resolved after API recreation. Web also joins a project ingress bridge for its published LAN port; the app network is internal. API has **no published host port**, joins the project-private app network and existing external `nexus-data`, and reaches `nexus-shared-postgres:5432`. No new PostgreSQL or Redis service is defined. This follows the [Docker frontend/internal-network pattern](https://docs.docker.com/engine/network/). Future outbound SMTP/auth-provider access needs its own reviewed egress decision because the current API networks are internal.

Web defaults to **128 MiB / 0.25 CPU**, API to **512 MiB / 1 CPU**, configurable with `MYFIN_WEB_MEMORY`, `MYFIN_WEB_CPUS`, `MYFIN_API_MEMORY`, `MYFIN_API_CPUS`. Both run without root privileges/capabilities, with read-only root filesystems and bounded `/tmp`. Health probes use Node's built-in fetch in the API and Alpine's wget in nginx. API health timeout allows pool checkout plus query timeout. Revisit probe/grace limits if timeout settings are changed.

Required deployment environment decisions (no port/hostname has been reserved):

| Variable / decision | Contract |
| --- | --- |
| `MYFIN_WEB_BIND_IP` | Verified runtime LAN bind IP, normally assigned on nexus-docker; no implicit public bind |
| `MYFIN_WEB_PORT` | Explicit verified unused port; no reserved default |
| `COMPOSE_PROJECT_NAME` | Proposed `myfin-dev` |
| `MYFIN_WEB_IMAGE`, `MYFIN_API_IMAGE` | Reviewed release image tags/digests; phase01 defaults are local artifact names |
| `MYFIN_DB_PASSWORD_FILE` | Absolute protected runtime password file, readable by container Node UID 1000; standalone Compose file secrets use bind mounts, so host ownership/mode matters |
| `MYFIN_UPLOAD_VOLUME` | Explicit pre-provisioned private external volume; owned by UID/GID 1000, mode 0700, mounted only at `/app/uploads` in API |
| `MYFIN_DB_NAME`, `MYFIN_DB_USER`, `MYFIN_DB_POOL_MAX` | Defaults above; independent production values later |
| `VITE_FIREBASE_*` | Existing public browser identifiers only, supplied intentionally for the selected Firebase environment; synthetic/absent values build but do not establish working login |
| Origin and access policy | Chosen owned dev hostname, existing tunnel route, development access protection, TLS/proxy trust decisions |
| Recovery | Independent DB/volume backup and restore evidence, retention, upload size budget, release rollback |

External volume means Compose will not create it implicitly. Provisioning its filesystem ownership/permissions and confirming backups are later operator steps. Upload functionality is not implemented; `UPLOAD_DIR=/app/uploads` reserves its future configuration contract. Do not mount migration credentials into the long-lived API. No volume is ever mounted by web. Runtime artifact destination is proposed `/srv/docker/apps/sange-myfin-manager` on nexus-docker; canonical source remains on nexus-pbund. Build one image at a time to preserve shared-host headroom.

## Reproducible source checks

From the canonical workspace:

```sh
export npm_config_cache=/root/myfin-jobs/phase01-foundation-20260912/reports/npm-cache
npm ci
npm ci --prefix server
node --test tests/pos.test.mjs tests/inventory.test.mjs
npm test --prefix server
npm run build
git diff --check
```

The existing build scripts were inspected: Vite builds local assets, then `scripts/build-offline.mjs` writes `dist/sw.js`. No production test/import was invoked. A frontend build without real Firebase browser configuration proves compilation only. Existing service-worker navigation behavior is unchanged; a direct browser navigation to `/api` under an already-installed service worker may still receive its offline shell on failure. Normal API fetches and nginx routing are separate. Address service-worker API exclusions in the later frontend/offline phase; this phase does not edit `src/` or existing build scripts.

## Future operator validation and deployment (not executed here)

Use a separately approved disposable PostgreSQL 16 target first. Supply `$MYFIN_VALIDATION_ADMIN_POSTGRES_DSN` and `$MYFIN_VALIDATION_ADMIN_MYFIN_DSN` privately (targeting `postgres` and `myfin_dev` respectively), plus a protected `$MYFIN_VALIDATION_MIGRATOR_ENV` containing that target's PG settings, password-file path, explicit PGUSER and MIGRATION_OWNER. Never point synthetic acceptance tests at the shared/live database. The following commands are future execution instructions, not evidence of an execution in this phase:

```sh
psql "$MYFIN_VALIDATION_ADMIN_POSTGRES_DSN" -X -v ON_ERROR_STOP=1 -f db/provision-development.sql
# Operator sets independent login passwords through the approved secret process.
node --env-file="$MYFIN_VALIDATION_MIGRATOR_ENV" server/src/migrate-cli.js
node --env-file="$MYFIN_VALIDATION_MIGRATOR_ENV" server/src/migrate-cli.js
psql "$MYFIN_VALIDATION_ADMIN_MYFIN_DSN" -X -v ON_ERROR_STOP=1 -f db/grant-development-runtime.sql
```

On that disposable target, verify second run applies zero; launch two migration attempts concurrently and observe locking; test an altered applied migration in a disposable source copy and require failure. Verify invalid roles/orphan memberships/duplicate mappings fail, runtime SELECT succeeds while DDL/ledger writes and SET ROLE owner fail, and rollback removes the entire failed batch. Record actual PostgreSQL version, SQL results and ACLs. Do not confuse these pending acceptance cases with the injected orchestration tests.

For a later approved runtime artifact on nexus-docker, populate a protected runtime environment file outside the source/build context and export its path as `MYFIN_RUNTIME_ENV`. Assign an unused LAN port and pre-provision the private volume. Resolve and record base-image digests, confirm external network and secrets, then:

```sh
cd /srv/docker/apps/sange-myfin-manager
docker compose --env-file "$MYFIN_RUNTIME_ENV" -f deploy/compose.yml config --quiet
docker compose --env-file "$MYFIN_RUNTIME_ENV" -f deploy/compose.yml build api
docker compose --env-file "$MYFIN_RUNTIME_ENV" -f deploy/compose.yml build web
docker compose --env-file "$MYFIN_RUNTIME_ENV" -f deploy/compose.yml run --rm --no-deps web -t
# Only after separately approved dev DB/role provisioning; use migration secret.
MYFIN_DB_PASSWORD_FILE="$MYFIN_MIGRATOR_PASSWORD_FILE" docker compose --env-file "$MYFIN_RUNTIME_ENV" -f deploy/compose.yml run --rm --no-deps -e PGUSER=myfin_dev_migrator -e MIGRATION_OWNER=myfin_dev_owner api node src/migrate-cli.js
# Operator applies the explicit runtime grants after migration.
docker compose --env-file "$MYFIN_RUNTIME_ENV" -f deploy/compose.yml up -d api web
docker compose --env-file "$MYFIN_RUNTIME_ENV" -f deploy/compose.yml ps
curl --fail "http://$MYFIN_WEB_BIND_IP:$MYFIN_WEB_PORT/healthz"
curl --fail "http://$MYFIN_WEB_BIND_IP:$MYFIN_WEB_PORT/api/health/live"
curl --fail "http://$MYFIN_WEB_BIND_IP:$MYFIN_WEB_PORT/api/health/ready"
curl -i "http://$MYFIN_WEB_BIND_IP:$MYFIN_WEB_PORT/api/companies"
```

The last endpoint must be JSON 404. Export bind IP/port in the operator shell for curl; Compose's env file does not export shell variables. Validate 503/readiness redaction with the disposable DB unavailable; verify nginx gateway failures do not return SPA HTML, actual health probes work, shutdown drains, API has no public port, volume survives app recreation and web cannot access it. Only then consider separately reviewed development ingress. Production import, restore, acceptance, offline queue handling and Firebase retirement are later gates.

Docker/Compose is unavailable on this controller. Local YAML parsing/static template checks cannot establish Compose interpolation semantics, image tools/permissions, actual networking, SQL execution or successful application deployment.
