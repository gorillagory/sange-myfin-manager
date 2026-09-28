# Phase 06: workspace routing, access roles and POS codes

## Approved model

`Workspace` is the tenant and may contain multiple companies/brands. Internal IDs never change when a name or slug changes. Workspace slugs are globally unique; company slugs are unique within a workspace. The production hostname is stored as an exact database mapping and rendered as:

```text
<workspace-slug>-<company-slug>.finn3.com
```

For example, workspace `bfsb` and company `bali` use `bfsb-bali.finn3.com`. The combined DNS label may not exceed 63 characters. A slug change creates a new canonical mapping and retains the previous hostname as a redirect alias. The API never guesses a tenant by splitting a hostname. Unknown wildcard hosts return a generic 404 before authentication.

## Roles

| Role | Scope | Approved capabilities |
|---|---|---|
| SuperAdmin | Global | Every workspace, company, person, transaction, lifecycle and setting |
| Workspace owner | One workspace | Every company, person, transaction and setting in that workspace |
| Manager | Assigned companies | Company operations, Operators, documents and reports containing sales, tax, expenses and cash flow |
| Operator | Assigned companies | Sales, new expense entries, inventory transactions, invoice/quote drafts, and device/printing preferences |

Acquisition cost, valuation, margin and profit stay owner-only. Integration credentials and company financial policy stay owner-only. Operators cannot edit existing expenses. An Operator expense void requires a Manager's own six-digit code and creates a one-action approval record. Posted financial rows are never hard-deleted.

## Authentication

Email/password login remains available on an assigned company hostname. `/poslog` provides fast six-digit access for Managers and Operators only. Codes are unique within a company, so the same digits may exist elsewhere. The host supplies company scope but is not an authentication factor.

The server uses a keyed company/code digest for lookup and a separately salted scrypt verifier, protected secret files, tenant lockout after repeated failures, opaque host-only sessions, expiry and audit events. POS-code sessions cannot open password-only administration. A Manager approval code is verified inside the same transaction as the approved action and cannot be reused as a general approval token.

Password sessions remain host-only. Company switching uses a 90-second, single-use handoff bound to the exact target hostname; the target creates its own host-only session. Session, role, suspension and company changes revoke password-handoff and POS sessions.

## Environments

Development remains the `myfin-dev` Compose project, database `myfin_dev`, port `192.168.1.100:8083`, independent secrets and `myfin-dev-uploads`. Its temporary external acceptance address is `dev-pos.bayam.live`; it will be removed after acceptance so development and its database are reachable only through LAN/Tailscale/SSH operations.

Production is prepared as `myfin-prod`, database `myfin_prod`, independent owner/migrator/runtime roles, independent auth/POS secrets, `myfin-prod-uploads`, and port `192.168.1.100:8084`. Production routing uses the existing Cloudflare Tunnel plus a proxied `*.finn3.com` record. `admin.finn3.com` is the control hostname. PostgreSQL remains private on `nexus-data` and is never a Cloudflare origin.

The development and production databases are logically isolated on the current shared PostgreSQL service and still share the same `nexus-docker`/PostgreSQL failure domain. Backups and restore drills must therefore be independent.

## Git and promotion

- `develop`: integrated development state and development deployment source.
- `staging`: release-candidate branch. Create/update it only from a tested `develop` commit.
- `main`: production branch. Advance it only by fast-forwarding the accepted staging commit.
- Release images are built once from an exact commit, recorded by digest, tested in staging, then promoted unchanged to production.

The remote `main` diverged before Phase 06. It must not be force-pushed. Reconcile it explicitly after development acceptance, preserve its history, and then establish the staging/main promotion chain.

## Rollout gates

1. Run all source and isolated PostgreSQL tests, including the complete migration chain and rollback rehearsal.
2. Back up `myfin_dev`, runtime environment/secrets metadata and uploads; record hashes outside the runtime host.
3. Apply migration 0013, seed the exact temporary development host mapping, and deploy the accepted image digests only to `myfin-dev`.
4. Verify unknown-host rejection, normal login, `/poslog`, lockout, multi-company handoff, role projections, Manager reports, Operator approval, session revocation and financial immutability.
5. Move development ingress from `dev-pos.finn3.com` to `dev-pos.bayam.live`, verify it, then remove the old route.
6. Stop at browser acceptance. Do not import Firebase production data or publish `*.finn3.com` until reconciliation and explicit production acceptance are complete.
