# Historical Firebase reference adapters

These files preserve selected pre-Phase-02 adapters and package manifests. They are not imported by the active Vue app or copied into Docker images. The full dirty pre-job snapshot, including all UI, rules and printing changes, is `/root/myfin-jobs/phase02-postgres-app-20260912/source-before.tar.gz` and its source manifest. Use that complete artifact for an explicitly reviewed rollback/rehearsal; this directory alone is not a complete runnable release.

Original root Firebase deployment/rules configuration is retained but was not deployed. The PostgreSQL build uses same-origin `/api` and must not be published through the old frontend-only deployment workflow. Old-origin IndexedDB paid queues require explicit drain/reconciliation and historical UID mapping; do not purge them or merge accounts by email.
