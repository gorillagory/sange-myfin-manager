# SuperAdmin genesis and lifecycle

Development deployment was verified on 29 September 2026 (28 September UTC) from commit `ad37cbd3db9236a0bf2f9499976300dcc668aef6`, API image `myfin-api:phase07-ad37cbd` (`sha256:24695c4f45db6007239e3dc52b65e4d7ae967f588e6316757cca78f7746cff50`). The live command refused with `genesis_already_initialized`; the active SuperAdmin count stayed at three, the genesis-event count stayed at zero, and public readiness remained healthy. This proves the deployed refusal path without creating or changing an identity.

MyFin has one deliberately narrow genesis entry point: an offline container command run with the environment's migrator credential and database-owner role. There is no HTTP genesis, signup, default account, hard-coded password or hostname bypass.

Genesis is valid only after migration `0013_workspace_routing_access.sql` and only while the target database has zero active SuperAdmins. A transaction-scoped advisory lock serializes attempts. Identity, credential and `genesis_super_admin_created` management event commit together; any failure rolls the whole operation back. The command validates an exact tuple for `myfin_dev` or `myfin_prod` and reads the password from a protected file. It never prints the password.

After genesis, additional SuperAdmins are created through the authenticated user-management API by an active SuperAdmin using a password session. The API already prevents suspension or demotion of the last active SuperAdmin. Workspace owners, managers and operators cannot grant global SuperAdmin access.

Development invocation on `nexus-docker`:

```sh
export MYFIN_RUNTIME_ENV=/srv/docker/secrets/myfin-dev/runtime.env
export MYFIN_MIGRATOR_PASSWORD_FILE=/srv/docker/secrets/myfin-dev/migrator.secret
export MYFIN_GENESIS_PASSWORD_FILE=/srv/docker/secrets/myfin-dev/genesis.secret
export MYFIN_GENESIS_EMAIL='reviewed-address@example.com'
export MYFIN_GENESIS_DISPLAY_NAME='Reviewed administrator name'
export MYFIN_REVIEWED_DEV_GENESIS=myfin_dev
scripts/deploy/genesis.sh
```

Production uses the corresponding protected `myfin-prod` paths and `MYFIN_REVIEWED_PROD_GENESIS=myfin_prod` with `scripts/deploy/production-genesis.sh`. Run it after production provisioning and migrations, before public ingress. Production genesis cannot run against the development database, and the development command cannot run against production.

The current development database already has active SuperAdmins from its controlled seed/import history, including named owner identities with password credentials. Its genesis command therefore refuses with `genesis_already_initialized`. Create any additional development SuperAdmin through the existing authenticated SuperAdmin management flow.

Production genesis completed on 29 September 2026. The audited first account is `nik@bayamtech.com`; the production-only password remains in protected file `/srv/docker/secrets/myfin-prod/genesis.secret`. The production control URL and recovery evidence are recorded in [PRODUCTION_GENESIS_20260929.md](PRODUCTION_GENESIS_20260929.md). Firebase was not changed.
