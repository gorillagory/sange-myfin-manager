# Historical Phase03/04 development acceptance

The following is the preserved 12 September 2026 acceptance guide. Its images, counts, job paths, statuses and next-step wording are historical. Use [the current Phase05 guide](MYFIN_DEV_ACCEPTANCE.md) for the current release. This record is retained for audit and recovery context; do not execute old commands without checking current state and the approved recovery plan.

---

# MyFin development acceptance - 12 September 2026

## Latest state — Phase04, 12 September 2026

User/company management is deployed and verified at **https://dev-pos.finn3.com**. Read [MANAGEMENT_MODULES.md](MANAGEMENT_MODULES.md) for the new company/people directories, atomic enrollment, suspension/reactivation, company archive/restore, session controls, permissions and recovery notes. 66 automated checks and 15 browser checkpoints passed; both live containers use the exact accepted images and migration0009. The old development backup is checksum-verified off-host. The 15 other application containers are preserved.

The owner-authorized Firebase extraction is also complete:118 Firestore documents and9 authentication metadata profiles, with passwords/tokens excluded; configured Storage has0 current objects. Protected copies and reconciliation exceptions are described in [FIREBASE_EXTRACTION_20260912.md](FIREBASE_EXTRACTION_20260912.md). These historical records are **exported, not imported** into the new app. Production Firebase is unchanged. Next data work is a reviewed isolated import rehearsal with explicit ID, finance and identity reconciliation, followed by data acceptance.

Current job packet: `/root/myfin-jobs/phase04-management-20260912`. User-facing browser review can proceed at the existing development URL. No additional source writer or deployment job should be started merely to repeat completed work. Canonical source remains on nexus-pbund; no commit or push was performed. The Phase03 material below is retained as history.


The PostgreSQL-backed development POS is live at **https://dev-pos.finn3.com**. **pos.finn3.com is reserved for a future production environment and has not been published.** This development shop contains synthetic data; production Firebase has not been imported or cut over.

## Open and sign in

Open https://dev-pos.finn3.com from any normal browser. No SSH forward or this Windows PC is required for application access. The task-owned Windows localhost forward has been closed, and the deployed API no longer accepts the localhost test authentication origin.

Development operator: **operator@myfin.test**. Read its generated password on nexus-pbund using the existing trusted SSH/Tailscale route:

```sh
cat /root/myfin-recovery/dev-20260912/secrets/acceptance-password
```

Do not paste passwords into chat, Git or public reports. The synthetic operator is for development acceptance only. Browser acceptance and physical-printer checks remain with the user.

## Current topology

| Component | Role |
| --- | --- |
| nexus-pbund, CT101 / 192.168.1.103 | Canonical source/controller and existing sange-integrator cloudflared tunnel |
| nexus-docker, CT100 / 192.168.1.100 | MyFin development web/API and existing shared PostgreSQL runtime |
| temp-mailserver, CT200 / 192.168.1.18 | Existing Mailcow/mail data; outside this change |
| Squarespace | finn3.com registrar; domain registration remains here |
| Cloudflare | finn3.com authoritative DNS, public HTTPS and existing tunnel ingress |

The route is dev-pos.finn3.com -> existing tunnel -> http://192.168.1.100:8083 -> MyFin web -> private API. The API connects to nexus-shared-postgres:5432 over the existing nexus-data Docker network.

- Canonical source: /root/workspaces/sange-myfin-manager on nexus-pbund; main c49b3e82249ee9e51de967c0c4bebb4a58ce7d56 plus preserved dirty work and the migration implementation. No commit or push.
- Runtime artifact: /srv/docker/apps/sange-myfin-manager on nexus-docker.
- Compose project: myfin-dev; containers myfin-dev-web-1 and myfin-dev-api-1.
- Database: isolated myfin_dev with independent owner, migrator and runtime roles; eight migrations applied.
- Private uploads: myfin-dev-uploads, UID 1000, mode 0700.
- Protected runtime configuration and secrets: /srv/docker/secrets/myfin-dev.
- API: NODE_ENV=production, AUTH_BASE_URL=https://dev-pos.finn3.com, no AUTH_LOCAL_TEST override. This is the hardened runtime profile for the DEVELOPMENT deployment.
- Accepted source tree: 07a53bc7c5116855854668471fda7dfd9b0ae49039470cb964b23cdbd669a0f1.
- API image: sha256:631e3b27634f2fdee4323e9d8fc1efa6c4f31ac808fcfd6b712f959cd4d95512.
- Web image: sha256:dc03e15217e5e997fb3db3471c1171af1d69f7422bcb5c79bdcf663465349443.

Only MyFin API was recreated for HTTPS. The other 16 observed containers retained their IDs, running states and start times. Existing Sange, mail, Casebuilder, BHR and other platform workloads were preserved. Application source was unchanged after the accepted deployment; continuation documentation was updated.

## DNS and publication evidence

The user confirmed the nameserver/DNSSEC transition. Authenticated Squarespace review found exactly ten original records and no custom records. Cloudflare's scan missed the apex HTTPS record; it was independently verified and added. All original record names, types and destinations were preserved as DNS-only, with Cloudflare Auto TTL (300 seconds). A single proxied CNAME was added for dev-pos.finn3.com.

- Zone: finn3.com, Cloudflare Free, ID 9a1a7285284980f14c73469bef823ddc.
- Nameservers: guy.ns.cloudflare.com and raquel.ns.cloudflare.com.
- Existing tunnel: sange-integrator, ID 75278e29-3fcf-4c9d-9baf-44d24cae7a10, active replica nexus-pbund.
- Original five routes are unchanged and retain their order: sys.bayam.live:8080; sys-dev.bayam.live:8081; btravel-dev.bayam.live:8081; bhr-dev.bayam.live:8082; mail-control.bayam.live:8093. All service addresses are 192.168.1.100.
- Sixth route: dev-pos.finn3.com -> http://192.168.1.100:8083, no path restriction, default tunnel application settings.
- DNSSEC DS at Squarespace: 2371 13 2 D3F517C0546F5446B8FDF7A13FD894C0C26D77AD69E2564CC60DC93888098AC4.

The old DS was verified absent at .com and two public resolvers before the nameserver change. The new DS and delegated nameservers were subsequently verified at both sampled .com authorities. At 11:37 UTC, both 1.1.1.1 and 8.8.8.8 validated apex and dev-pos A responses with AD and NOERROR. An isolated Cloudflare recursive apex NS SERVFAIL cleared by 11:38:27 UTC; UDP/TCP NS responses and both authoritative signed NS sets then validated correctly. No cache flush or protection disablement was used to resolve it. DNSSEC is restored and verified on these sampled paths; this does not assert that every resolver worldwide has finished propagation.

## Acceptance evidence

Phase 02 passed 51 tests: 14 domain, 15 API foundation, 11 offline/hydration and 11 real PostgreSQL test groups, plus seven Chromium workflow checkpoints. Workflows covered login, company/product/photo changes, contacts, online POS, receipts/PDF/CSV, paid offline reload/reconnect, offline logout/relogin and logout, without duplicate stock deductions. The final isolated paired restore matched 13 synthetic transactions, one real private upload and eight migrations.

The persistent deployment passed runtime database ACL checks: no schema creation, owner-role assumption, migration-ledger updates or audit-history deletion. Public HTTPS acceptance passed at 11:28:02 UTC: certificate validation, web/API health, anonymous access rejection, missing/wrong Origin and cross-site auth denial, operator login, Secure/HttpOnly/SameSite=Lax host-only session cookies, synthetic company scope, six business collection reads, logout and rejected replay of the revoked cookie.

Cloudflare's Browser Integrity Check rejects Python urllib's default client signature (1010). The acceptance client identifies itself honestly as MyFinAcceptance/1.0; Cloudflare protection settings were not weakened. A normal public browser loads the login page and reports that the offline app is ready.

Reports on nexus-pbund:
- /root/myfin-jobs/phase02-postgres-app-20260912/reports/result.json
- /root/myfin-jobs/phase03-dev-deployment-20260912/reports/result.json
- /root/myfin-jobs/phase03-dev-deployment-20260912/reports/https-acceptance.json
- /root/myfin-jobs/phase03-dev-deployment-20260912/reports/https-rollout.json
- /root/myfin-jobs/phase03-dev-deployment-20260912/reports/finn3-registrar-review.json
- /root/myfin-jobs/phase03-dev-deployment-20260912/reports/finn3-publication.json

## Backup and recovery

A quiescent initial database/private-files backup is on nexus-docker at /srv/docker/backups/myfin-dev/phase03-initial-20260912. Its checksum-verified off-host copy is on nexus-pbund at /root/myfin-recovery/dev-20260912/initial-backup. Credential material stays in the associated protected secrets directory. The checksum-verified current HTTPS configuration is /root/myfin-recovery/dev-20260912/secrets/runtime.public-https.env. The populated restore rehearsal belongs to disposable Phase 02 tests; no restore was run over the persistent development database.

Do not expose the localhost test authentication profile through the public tunnel. If local-profile troubleshooting becomes necessary, first remove public access to that profile and follow the documented recovery procedure. DNS rollback is not data rollback. Preserve all old-origin paid queues before any future production origin change.

## User acceptance and remaining production work

Verify login, shop selection, inventory and variants, a synthetic checkout, saved receipt/PDF, offline paid-queue recovery, contacts, expenses, invoices/quotes, and staff access on your devices. Check physical receipt/label printers separately. Payment processors and real card/QR settlement are not certified by these tests.

Public development acceptance does not complete production migration. SMTP invitations/reset delivery, identity mapping, production export/import/reconciliation, till-outbox drain, a separate production deployment/database, and publishing pos.finn3.com remain future work after acceptance. Keep Firebase production active until that cutover is explicitly completed.

## Continue from another computer

Connect to nexus-pbund through the existing trusted SSH/Tailscale route and use /root/workspaces/sange-myfin-manager. Read this guide and docs/NEXUS_CONTINUATION.md. The latest packet is /root/myfin-jobs/phase03-dev-deployment-20260912.

```sh
python3 /root/myfin-jobs/status.py
python3 /root/myfin-jobs/status.py tail
```

Source and deployment jobs are complete. The job-progress heartbeat is paused at human browser acceptance. Avoid a second source writer and preserve the Windows/imported checkout as references.
