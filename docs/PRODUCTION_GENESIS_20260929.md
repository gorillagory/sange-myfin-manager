# Production genesis receipt — 29 September 2026

MyFin production is live at **https://pos.finn3.com**. This is the control surface for the SuperAdmin to enroll workspaces and companies. Enrollment creates company hostnames such as `bfsb-bali.finn3.com`; Cloudflare route `*.finn3.com` sends unmatched production subdomains through tunnel `75278e29-3fcf-4c9d-9baf-44d24cae7a10` to `http://192.168.1.100:8084`.

The active production administrator is `gorilla@bayamtech.com`, display name `Gorilla`, role `super_admin`. Its generated production-only password remains in `/srv/docker/secrets/myfin-prod/gorilla-admin.secret` on `nexus-docker`, mode `0600`; the value is not stored in Git or this receipt. Public password login was exercised successfully and `/api/me` returned password authentication with the SuperAdmin role.

The initial `nik@bayamtech.com` genesis identity was replaced at the owner's request. The new SuperAdmin was created and its login verified before the old identity was suspended. All old sessions were revoked, the old password login returns HTTP 401, and `/srv/docker/secrets/myfin-prod/genesis.secret` was deleted. The suspended identity remains only as referential audit history because management events cannot be erased safely.

Production uses database `myfin_prod`, roles `myfin_prod_owner`, `myfin_prod_migrator` and `myfin_prod_runtime`, upload volume `myfin-prod-uploads`, and Compose project `myfin-prod`. All 13 migrations are applied. Initial state is one active SuperAdmin, one `genesis_super_admin_created` event and zero companies.

| Runtime | Verified value |
| --- | --- |
| Application commit | `ad37cbd3db9236a0bf2f9499976300dcc668aef6` |
| API | `myfin-api:phase07-ad37cbd`, healthy, container `94283f0a6529b4f3eb61c4c299b88ea8fd1996bbd6eed88490e8a51a7ac13bdc` |
| Web | `myfin-web:phase06-0de74b2`, healthy, container `45108eb963893894888233e1294a86b44fa9d12de02ef93d1aed69445ec56f5b` |
| LAN origin | `192.168.1.100:8084` |
| Runtime configuration hash | `885f0d43fba4b843660624fd193e89be4ff7b8bd8a1d90f01f2b284663af61c5` (`runtime.env`; secret values excluded) |

The initial database/upload backup is `/srv/docker/backups/myfin-prod/bootstrap-20260929` on `nexus-docker` and checksum-verified off-host at `/root/myfin-recovery/prod-20260929/bootstrap` on `nexus-pbund`. A disposable restore reproduced `13 migrations | 1 active SuperAdmin | 1 genesis event | 0 companies` and was removed. Backup SHA-256 values are `c7cbef4c…d9e4b` for `database.dump`, `476e4ca8…fd71` for `uploads.tar.gz`, and `48bc1da5…58aa` for `counts.json`.

The post-rotation backup is `/srv/docker/backups/myfin-prod/admin-rotation-20260929`, checksum-verified off-host at `/root/myfin-recovery/prod-20260929/admin-rotation`. Its disposable restore verified one active SuperAdmin, active `gorilla@bayamtech.com`, and suspended `nik@bayamtech.com`, then the restore database was removed.

The prior Firebase production application and its data were not imported, edited or disabled. `dev-pos.bayam.live` remains the development environment. The older `dev-pos.finn3.com` transition route still exists separately and should be removed only after its explicit cleanup step.
