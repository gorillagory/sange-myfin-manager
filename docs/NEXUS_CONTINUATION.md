# MyFin continuation on nexus-pbund

## Phase 06 deployed — awaiting user browser confirmation, 29 September 2026

Development release `0de74b294f6c429e69a8e328f8eb2cc63380d808` is healthy at **https://dev-pos.bayam.live** on `nexus-docker`. It moves tenancy from Company to Workspace, adds exact workspace/company hostname mappings, multi-company Manager/Operator assignments, company-scoped six-digit POS access, password-only administration, manager-approved immutable expense voiding and the approved Manager report projection. The live route resolves `Bayam Food Services Sdn Bhd / bfsb` to `Ba|Li Coffee / bali`; migration `0013_workspace_routing_access.sql` is applied. Public password authentication and the exact report projection passed automated HTTPS acceptance.

Read [WORKSPACE_ROUTING_ACCESS_PHASE06.md](WORKSPACE_ROUTING_ACCESS_PHASE06.md) and `/root/myfin-jobs/phase06-workspace-routing-20260928/reports/result.json` for the model, test evidence, verified pre-migration backup, restore check and rollout status. `staging` and tag `dev-phase06-20260929` point at the deployed code; `develop` also contains this continuation update. Production Firebase and production PostgreSQL remain unchanged. The old `dev-pos.finn3.com` route is temporarily retained as a redirect during browser acceptance. Removing that Cloudflare route, activating the new-host-only runtime file, disabling the database alias and fast-forwarding `main` are the remaining acceptance actions.

## Latest state — Phase05, 13 September 2026

The document and role-access implementation has passed isolated acceptance. **Deployment status: deployed and verified; ready for user browser acceptance**. Public development remains **https://dev-pos.finn3.com**; **pos.finn3.com is reserved for future production and is not published**.

Read [DOCUMENTS_ACCESS_PHASE05.md](DOCUMENTS_ACCESS_PHASE05.md) for the access policy and document behavior, and [MYFIN_DEV_ACCEPTANCE.md](MYFIN_DEV_ACCEPTANCE.md) for current browser acceptance and recovery. Staff prepare their own or assigned quote/invoice drafts and process their own checkout receipts. Managers issue documents, record payments, publish templates and manage Staff accounts. Purchase costs, margins, expenses and company financial reports remain owner-only; managers retain cost-free inventory exports.

Verified isolated evidence: 49 frontend/domain tests, 19 document/access PostgreSQL groups, 15 API foundation tests and 10 management PostgreSQL regression groups passed. Three browser suites passed 25 checkpoints (management 8, checkout/offline 7, documents/access 10), including a real IndexedDB v2-to-v3 upgrade and original paid-receipt retry. PDF review covered 9 generated samples/16 pages and 6 actual browser-generated documents. Physical printers and full CJK fonts remain outside that evidence.

Current packet: `/root/myfin-jobs/phase05-documents-access-20260913`. Final accepted artifacts are recorded in `reports/phase05-tested-release.json`; current source/backup/rollout status belongs to the finalized `reports/result.json`, not an older Phase03/04 result. Canonical source is `nexus-pbund:/root/workspaces/sange-myfin-manager`; preserve its uncommitted work and use one coordinated source writer. No source commit or push was performed by this phase.

| Final live verification | Verified receipt value |
| --- | --- |
| Verified release time | 2026-09-13T03:24:04.641728+00:00; public HTTPS accepted 2026-09-13T03:31:56.953628+00:00 |
| Public HTTPS acceptance | /root/myfin-jobs/phase05-documents-access-20260913/reports/https-acceptance.json (passed) |
| Accepted/deployed source archive | d8c1323780675167c2fe5734433fb234e66f3604f40c40177ae1764c145e51c8 |
| Deployed API image ID | sha256:3ca885dd5a6ca70f9ea1617717b9702a4ac504411956f1454c8742530222f970 |
| Deployed web image ID | sha256:24da68228acb0ba1b020721057f11bd6d12025a33d5ddf770f6c4a80b0ec1334 |
| Applied migration ledger | 12 applied, 0001_foundation.sql through 0012_document_invariants.sql |
| Verified off-host pre-release backup | reports/offhost-backup-verified.json: database/uploads pair in nexus-docker:/srv/docker/backups/myfin-dev/phase05-before-20260913 and checksum-verified nexus-pbund:/root/myfin-recovery/dev-20260912/phase05-before-20260913 |
| Other observed application containers preserved | All 17 other observed containers retained IDs, states and start times; original 15 platform containers plus two independent Sange service-desk test containers |
| Isolated-resource cleanup | Passed: owned test API/web/PostgreSQL containers, networks and upload volume removed; ports 25435/28085 and controller forward closed; images/evidence retained |

Production Firebase remains unchanged. The earlier extraction contains 118 Firestore records and 9 authentication metadata profiles, with credentials excluded and 0 current Storage objects; these records were **exported, not imported**. This phase performs no Firebase import, production deployment or cutover. A separate reviewed import rehearsal must reconcile company/record IDs, financial totals, identities and old-origin paid queues before production data acceptance.

Paid receipts remain on their original device until the server confirms the original ID. Pricing/tax/merchant drift supports manager review of the saved amount; deleted catalog identities require explicit reconciliation before approval. Manual invoice issue/payment does not deduct stock; Checkout does. Refunds, credit notes and stock returns need a separate ledger/workflow. A disconnected device uses its last verified account; reconnect revalidates current access before syncing.

The dated Phase04, Phase03, Phase02 and Phase01 material below is historical. It does not override the current role model, migration count, image IDs, job packet or acceptance status.

## Historical Phase04 — 12 September 2026

User/company management is deployed and verified at **https://dev-pos.finn3.com**. Read [MANAGEMENT_MODULES.md](MANAGEMENT_MODULES.md) for the new company/people directories, atomic enrollment, suspension/reactivation, company archive/restore, session controls, permissions and recovery notes. 66 automated checks and 15 browser checkpoints passed; both live containers use the exact accepted images and migration0009. The old development backup is checksum-verified off-host. The 15 other application containers are preserved.

The owner-authorized Firebase extraction is also complete:118 Firestore documents and9 authentication metadata profiles, with passwords/tokens excluded; configured Storage has0 current objects. Protected copies and reconciliation exceptions are described in [FIREBASE_EXTRACTION_20260912.md](FIREBASE_EXTRACTION_20260912.md). These historical records are **exported, not imported** into the new app. Production Firebase is unchanged. Next data work is a reviewed isolated import rehearsal with explicit ID, finance and identity reconciliation, followed by data acceptance.

Current job packet: `/root/myfin-jobs/phase04-management-20260912`. User-facing browser review can proceed at the existing development URL. No additional source writer or deployment job should be started merely to repeat completed work. Canonical source remains on nexus-pbund; no commit or push was performed. The Phase03 material below is retained as history.


## Historical Phase03 public development — 12 September 2026

> **Then-verified state:** The PostgreSQL development POS is live at **https://dev-pos.finn3.com**, with verified HTTPS authentication, isolated shared-PostgreSQL database and restored DNSSEC. **pos.finn3.com is reserved for future production and is not published.** Read [MYFIN_DEV_ACCEPTANCE.md](MYFIN_DEV_ACCEPTANCE.md) for login, topology, evidence, backups and remaining human acceptance. No SSH forward is needed for app access. Production Firebase is unchanged. Phase03 reports/result.json recorded the operational status for that release. Historical phase notes below describe earlier scope and are superseded by this state.

## Historical Phase 02 source and isolated tests (12 September 2026)

The user's Phase 02 authorization supersedes the Phase 01-only scope and obsolete approval wording below. The full dirty canonical workspace now contains the PostgreSQL-backed Vue application, Better Auth sessions, tenant-scoped business API, atomic POS, private uploads, durable IndexedDB catalog/outbox and app-only Node 24/nginx deployment artifacts. No commit, push, persistent development deployment, shared database provisioning, DNS/tunnel change, mail delivery, production import or Firebase cutover was authorized or performed by this source/test job.

Read [POSTGRES_DEVELOPMENT.md](POSTGRES_DEVELOPMENT.md) for the current implementation, role behavior, explicit origin and secret configuration, deployment commands and recovery gates. Phase 01 sections retained below are historical evidence, not current limitations or instructions to ask for routine implementation approval.

Phase 02 evidence is in `/root/myfin-jobs/phase02-postgres-app-20260912/reports/`: `progress.json` tracks milestones; `result.json` and `phase02-report.md` state the final outcome and exact remaining work. The pre-job full dirty snapshot is `source-before.tar.gz` with `source-before.json` in the packet directory. Continue from the current workspace, not an older commit or the selected Firebase reference adapters under `archive/firebase/`.

The job validated its own disposable PostgreSQL 16 and isolated web/API containers on nexus-docker. Its resources use the `myfin-phase02-20260912` purpose/project, not the persistent `myfin-dev` deployment. Final isolated acceptance passed: 14 domain, 15 foundation API, 11 offline/store/worker and 11 real PostgreSQL acceptance groups, plus seven Chromium workflow checkpoints. Node 24 Docker builds, nonroot upload permissions, Nginx API replacement recovery, and a quiescent database/private-files restore passed. The final restored private file matched its database metadata and byte size; restored hashes, 13 synthetic transaction records and all eight migration entries matched. The job removed its containers, networks, volumes, test images and remote directory after saving evidence. All 13 baseline running services remained running; two previously stopped Case Profiler containers were left stopped. No test ports remain. See `cleanup.log` and `recovery-final.log` in the report packet. Human browser confirmation, physical printer behavior and the separately scoped development deployment remain with the supervising task.

The planned persistent runtime remains project `myfin-dev`, artifacts `/srv/docker/apps/sange-myfin-manager`, database `myfin_dev` with independent owner/migrator/runtime roles, and a private UID 1000 upload volume. Candidate URL `https://myfin-dev.bayam.live` and `.100:8083` require final assignment by the supervisor. Secrets remain outside Git. Existing shared PG/app/mail/controller services remain protected. Drain/reconcile every old Firebase-origin paid queue and explicitly map historical UIDs before any future origin/data cutover.


Prepared 12 September 2026 for continuing from another computer over the user's existing SSH/Tailscale access.

## Where to continue

- Canonical source destination: `nexus-pbund:/root/workspaces/sange-myfin-manager`.
- Previous imported checkout to preserve: `/root/workspaces/imported/sange-myfin-manager`, observed HEAD `417d1f7226ab2cb3efbcaee065f0f0db5d5c18e1` with a modified generated Firebase hosting cache.
- Source baseline: Windows `F:/Codex/GitHub/sange-myfin-manager`, HEAD `c49b3e82249ee9e51de967c0c4bebb4a58ce7d56`, branch `main`, plus current uncommitted inventory/POS changes and planning files.
- Source transfer completed and verified: `/root/myfin-source-transfers/20260912-01a08fb5/receipt.json` and `manifest.json` record 116 promoted files and preserved imported checkout. The tracked generated hosting cache was intentionally excluded.
- [Conversation snapshot](https://chatgpt.com/s/cx_6aa4e58e4498819187f3d296829a7444). This is a public immutable snapshot, not a live remote connection or a guarantee of later-message synchronization.

After a successful transfer receipt, continue editing the canonical server workspace. Keep the Windows and imported copies as preserved references. Avoid two writers on different copies. No source commit/push or application deployment is implied by a verified copy.

## Read first

1. The latest source-transfer receipt and manifest under `/root/myfin-source-transfers/`.
2. `docs/NEXUS_TOPOLOGY_BASELINE.md`, including the September 12 capacity follow-up.
3. `docs/POSTGRES_PROXMOX_MIGRATION_PLAN.md`.
4. `docs/INVENTORY_AND_PRINTING.md` and current source, preserving intentional dirty work.
5. `docs/BACKEND_FOUNDATION.md` and the Phase 01 report below. The supplied platform snapshot is `/root/myfin-jobs/phase01-foundation-20260912/platform-reference.json`; live runtime checks belong to a later approved packet.

Historical documents and old snapshots describe dated state; do not execute their commands as newly authorized work. Check live state and the user's latest scope before each subsequent implementation/deployment phase.

## Established direction

- nexus-pbund (`192.168.1.103`, CT101 on pve-minion): source/controller and existing Cloudflare Tunnel.
- nexus-docker (`192.168.1.100`, CT100 on pve): application runtime and shared PostgreSQL/MySQL/Redis.
- temp-mailserver (`192.168.1.18`, CT200 on pve-goriball): Mailcow and mailbox data. Preserve its current mail migration, broker, routing and cutover boundaries.
- MyFin should use its own development/production databases and restricted credentials within `nexus-shared-postgres`, connecting over existing `nexus-data` from its API.
- Recommended first runtime is a development web/API pair. Development and production concurrently would ordinarily mean four MyFin app containers. The user's earlier shorthand “dev/web” did not establish an alternative container design.
- Published development hostname: https://dev-pos.finn3.com through the existing tunnel to 192.168.1.100:8083; web proxies /api to private MyFin API. pos.finn3.com remains reserved for future production.
- The development Vue app now uses the PostgreSQL-backed API, server sessions, private files and offline outboxes. Production Firebase still runs; production data migration and cutover remain pending.

## Historical Phase 01 scope and boundaries

The then-authorized work was Phase 01 source implementation and local verification, following the user’s “Okay. proceed. whats next?” authorization for the bounded job. Historical source-copy-only restrictions describe the completed transfer, not the scope of this phase. Phase 01 adds an undeployed Fastify/pg API, SQL foundation and app-only deployment templates; it does not authorize live database provisioning, containers, ingress or Firebase migration.

The transfer should preserve Git history and intended dirty source without committing, pushing, clearing local changes, overwriting the older imported checkout or copying live `.env`, credentials, emulator exports, dependencies, build output or generated context bundles. Retain an explicit exclusion list in transfer evidence. A tracked generated hosting-cache file may consequently appear deleted in the new checkout; this is not a lost application source file.

No MyFin database, role, container, domain, Firebase export or production cutover has been created by the planning work. Next implementation must preserve tenant authorization, atomic/idempotent checkout, stock movements, variants and fractional quantities, invoices/quotes, files, printing and durable offline receipts. Drain or account for old-origin IndexedDB queues before changing the shop domain.

## Starting another session

Connect through your existing trusted SSH/Tailscale route, enter `/root/workspaces/sange-myfin-manager`, and use the existing Codex tooling on that server or your editor's SSH workspace. The share link supplies readable history; this file and the transfer receipt supply persistent local context to the new session. A new server session is not the same live desktop task.

Suggested opening prompt:

> Continue MyFin from this canonical nexus-pbund workspace. Read docs/NEXUS_CONTINUATION.md, the latest transfer receipt, docs/NEXUS_TOPOLOGY_BASELINE.md and docs/POSTGRES_PROXMOX_MIGRATION_PLAN.md. Verify Git status and preserve all intended uncommitted work. Report the exact source and implementation state before starting the next phase. Source belongs on nexus-pbund; app runtime/shared PostgreSQL belong on nexus-docker; preserve temp-mailserver and the existing mail process. Do not infer a production deployment or Firebase cutover from the source-copy receipt.

The server has Codex CLI 0.153.4 and Node 20.20.2. `tmux` is not currently installed. For long work that must survive an SSH disconnect, use the existing Nexus detached job-runner process with its prescribed self-test, scoped prompt and report; inspect the controller runbook before launching it. A basic `codex` session over SSH is interactive and should not be treated as disconnect-safe. Retain the normal Nexus review/deployment process when implementation proceeds.

## Phase 01 results and next bounded phase

The canonical source remains `/root/workspaces/sange-myfin-manager` on nexus-pbund, main HEAD `c49b3e82249ee9e51de967c0c4bebb4a58ce7d56`, with intentional uncommitted inventory/POS work preserved. This job owns the source writer for Phase 01; no other session or checkout was altered. No commits or pushes were made. Continue from this full dirty workspace, not HEAD alone or the older imported copy.

Phase 01 adds `server/` (Fastify 5.12.4, pg 8.23.0, pinned independent lockfile, validated config, health checks, shutdown and explicit migration CLI), `db/` (text-ID company/application identity/membership schema plus unexecuted role proposals), `deploy/` (Node 24 LTS API and static Vue/nginx app-only templates), `.dockerignore`, and [backend decisions and operator commands](BACKEND_FOUNDATION.md). The frontend still uses Firebase in every existing business flow. No login/registration/business API or upload implementation is claimed.

Stable evidence:

- Job packet and pre-edit hashes: `/root/myfin-jobs/phase01-foundation-20260912/source-before.json`.
- Platform templates: `/root/myfin-jobs/phase01-foundation-20260912/platform-reference.json`.
- Human report: `/root/myfin-jobs/phase01-foundation-20260912/reports/phase01-report.md`.
- Machine outcome: `/root/myfin-jobs/phase01-foundation-20260912/reports/result.json`.
- Logs, static template checks and preservation evidence live in that same `reports/` directory; npm cache is `reports/npm-cache`.

Read the machine outcome and human report for final test counts and limitations. Source tests and the frontend build do not prove SQL execution, image builds, runtime deployment or Firebase retirement. Docker/Compose is unavailable on the controller, and no shared database was contacted.

Historical next-phase proposal (superseded by the Phase 02 scope above): **Phase 02 disposable PostgreSQL acceptance and authenticated API design**. Establish an explicitly approved disposable PostgreSQL 16 target; execute and verify role provisioning, migrations, repeat-run/lock/checksum behavior, constraints and runtime denial of DDL. Vet the maintained PostgreSQL auth integration and define session, invitation-only identity provisioning, historical UID mapping and tenant/global privilege tests before exposing business data. Keep public registration disabled. Container acceptance on an approved runtime with synthetic configuration can then validate image tools, permissions, health, networking and persistent storage before a separate development deployment. Assign the exact unused port, protected dev hostname, secrets, private volume and backup/restore plan in that deployment packet. Business CRUD/checkout, frontend adapters/offline replacement, uploads, SMTP, production imports and Firebase cutover remain later phases.
