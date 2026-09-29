# MyFin production operations release — 30 September 2026

The development-accepted SKU, inventory, rounding, receipt-review, expense CSV,
stock-ledger and theme release is live at **https://pos.finn3.com**. This is the
first production promotion in this work session; the later Orders/layout/report
work is a separate rollout. Git `develop`, `staging` and `main` advanced by
fast-forward to `3ac9c0c` before deployment. The production source snapshot is
`nexus-docker:/srv/docker/releases/sange-myfin-manager/3ac9c0c`, linked from
`/srv/docker/apps/sange-myfin-manager-prod`. The development source and runtime
remain separate.

## Recovery point

The production API alone was stopped for a quiescent backup and restarted
healthy. Database and uploads are at
`nexus-docker:/srv/docker/backups/myfin-prod/pre-operations-20260929T165608Z`.
The checksum-matched off-host copy is at
`nexus-pbund:/root/myfin-backups/myfin-prod/pre-operations-20260929T165608Z`.
The SHA-256 values are:

| File | SHA-256 |
| --- | --- |
| `database.dump` | `98cff80c4641dc7aab050bf57df983e2fd76f1577adc37dce104cf71f10fd6da` |
| `uploads.tar.gz` | `ec51fd25df65d6970140ab72baf514fd9f7d9fcee58b0a01d2e0eeb96d76a90a` |

A disposable PostgreSQL restore succeeded with 13 pre-release migrations, one
company, 45 products, zero transactions and zero expenses. The disposable
database was dropped. The backup scripts are production-specific; the
development backup script must never target this database.

## Promotion and verification

The exact tested development images were retagged for production without a
rebuild:

| Service | New production image | Image ID |
| --- | --- | --- |
| API | `myfin-api:prod-operations-5145384` | `sha256:9e2fb4b27241b9bfe34db19a310f34aa5ed76c2ed576f0b178da2feeab24ec23` |
| Web | `myfin-web:prod-operations-5145384` | `sha256:c69145651f08d1162800f1fca5fa4ea9bda43be2d5667909305825978579c680` |

The prior protected runtime is retained as
`/srv/docker/secrets/myfin-prod/runtime-before-operations-5145384.env`;
the selected version is `runtime-operations-5145384.env`, with `runtime.env`
active. Prior production images remain tagged `myfin-api:phase07-ad37cbd`
and `myfin-web:phase06-0de74b2`. Their image IDs are
`sha256:24695c4f45db6007239e3dc52b65e4d7ae967f588e6316757cca78f7746cff50`
and
`sha256:0bfb241636e8c0e0dd6acbde0bd8d47ea783ce4fcd1110804e0c465360c447c3`.

The new API image applied migrations `0014` and `0015`; a repeat applied zero.
The first grant pass used the script's default PostgreSQL admin role, which is
absent on this cluster. Re-running with `MYFIN_PG_ADMIN_ROLE=platform` applied
all production runtime grants. The verified production migration count is 15.
Only `myfin-prod-api-1` and `myfin-prod-web-1` were recreated. Both became
healthy, the LAN production smoke passed, public `/healthz` and
`/api/health/ready` passed, `pos.finn3.com` resolved as the control surface,
unauthenticated `/api/me` returned 401, and a protected SuperAdmin sign-in
verified the company, product and stock reads over public HTTPS. The public
smoke did not create business records.

The existing production company and its 45 products are available for SKU
updates. Firebase was not imported or changed. If an application rollback is
needed, select the retained prior runtime and images, then run the guarded
production up command; the additive database migrations can remain. After new
business writes, restoring this pre-release database would discard them, so
review any database recovery separately.
