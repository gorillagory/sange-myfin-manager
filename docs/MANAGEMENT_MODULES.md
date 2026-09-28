# User and company management — Phase04

Live development URL: https://dev-pos.finn3.com. Public HTTPS acceptance passed on 12 September 2026 at 14:23 UTC. This is the development application; production Firebase has not been cut over.

## Operator workflow

As a workspace owner, choose **Switch workspace** (or **All companies & enrollment** on Company profile) to open the company directory. **People & access** manages accounts across companies. Company managers use **Team & access** and **Company profile** for their own business.

**Enroll company** collects company name, registration, contact details, address, currency, default tax, logo and payment QR. Choose to manage it yourself, create a new manager, or assign an eligible existing active account without a company. Review the details and enroll. Company and administrator changes commit together. A lost response keeps the dialog open so **Retry enrollment** can recover the same result without a second company.

The people directory supports name/email search and company, role and status filters. Create staff or managers, change their name/role/company, suspend/reactivate access, or sign out their sessions. Sign-in email is intentionally read-only. Use **My profile** for your own name and password. Initial passwords are not emailed and are not described as automatically expiring; no recovery-email service was added.

Suspension preserves company assignment and history but revokes existing sessions. An unrelated edit preserves suspension. Keep another active manager assigned before suspending, moving or demoting the last company manager. Own-account lifecycle changes are blocked; global owner safeguards also run under a transaction lock.

Archiving a company hides it from active workspaces and signs out its teammates while retaining records, private files and memberships. Filter for archived companies to restore it. Restoration permits retained active members to sign in again with existing credentials; suspended users remain suspended. Management actions require connectivity, while the existing offline checkout queue remains intact.

## Implementation and verification

The existing single-company membership model is retained. Company enrollment is super-only and accepts a stable UUID enrollment ID. Stored request fingerprints use keyed HMAC, and receipt/audit data excludes credentials. Existing administrator selection requires a local credential account; historical identities are not silently granted access.

Migration `0009_management.sql` adds `company_enrollments` and `management_events`. Runtime gets SELECT/INSERT only on both. Lifecycle operations and management directory reads revalidate the current identity and original session after acquiring the management lock. This covers requests queued before a role change or session revocation. Audits record company/user lifecycle changes with no passwords or tokens.

Validation passed: 14 domain tests, 11 offline tests, five frontend management tests, 15 API foundation tests, ten real PostgreSQL management groups and 11 established PostgreSQL regression groups — 66 total. Eight management browser checkpoints and seven existing POS checkpoints also passed. Tests include enrollment rollback/retry, lost responses, suspended-state retention, scope denial, session revocation races, archive/restore, last-manager safeguards, mobile layout, file ownership, PDFs/CSV and offline payment recovery with exactly-once stock deduction. All mutating acceptance fixtures ran in the isolated Phase04 environment.

Public verification confirmed valid TLS, authenticated management directory contracts, exact-Origin guards, Secure/HttpOnly/SameSite cookies, scoped reads and server-side logout. The public login page and service worker loaded in the user's browser. Human review of the upgraded authenticated screens remains available at the development URL.

## Release and recovery

Canonical source: `nexus-pbund:/root/workspaces/sange-myfin-manager`. No commit or push was made; all earlier uncommitted work was preserved. Source snapshot and Git bundle are under `/root/myfin-jobs/phase04-management-20260912/`.

The deployed source archive SHA-256 is `28988316116649b4842dc94a9763f0353edd423f3968ee230d4500563d89161c`. The 168-file runtime artifact was accepted before deployment. Later handoff documentation updates are recorded separately; image build inputs are unchanged.

API image: `sha256:c3f91c9a762224ffda64c4604c66a3a08f46e2edc9fa5ae21604d483bc31c7ed`.

Web image: `sha256:5f891e0820a00dff4a194b805c0fb8eb0c2c01f86ab8e09b44b1a779b60645f9`.

Deployment replaced only `myfin-dev-api-1` and `myfin-dev-web-1` at the existing port8083 route. All 15 other application containers retained their identity, running state and start time. Cloudflare/DNS/security settings, the shared PostgreSQL platform, mail infrastructure and production domains were not reconfigured.

The quiescent pre-release backup is on nexus-docker at `/srv/docker/backups/myfin-dev/phase04-before-20260912`, with a checksum-verified off-host copy on nexus-pbund at `/root/myfin-recovery/dev-20260912/phase04-before`. Previous runtime source and protected environment are retained under `/srv/docker/myfin-deployments/phase04-20260912/`. Prefer a forward fix: old API images understand the additive schema but use older destructive membership lifecycle semantics. Do not run an old migration image after0009, and block lifecycle operations if an old web/API rollback is necessary. A stopped rollout must be inspected before retrying.

## Existing MyFin data

Read-only Firebase extraction is complete: 118 Firestore records, nine authentication metadata profiles and zero current Storage objects. Embedded images remain preserved. Raw exports are protected on nexus-pbund and the originating Windows computer, outside Git and web hosting; passwords and tokens were not exported. See [the extraction and reconciliation report](FIREBASE_EXTRACTION_20260912.md).

Historical data has not been loaded into the new development database. Four stored IDs differ from Firestore document IDs, one transaction needs type/total reconciliation, and some historical activities lack actor IDs. Preserve those originals and rehearse explicit import mappings before applying business-data changes. Production Firebase remains the source of truth.
