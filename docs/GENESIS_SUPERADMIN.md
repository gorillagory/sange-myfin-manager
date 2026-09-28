# SuperAdmin genesis and lifecycle

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

The current development database already has active SuperAdmins from its controlled seed/import history. Its genesis command must therefore refuse with `genesis_already_initialized`. Create the owner's named development SuperAdmin through the existing authenticated SuperAdmin management flow. Production has not been provisioned, so its genesis account is created only after the empty production database exists.
