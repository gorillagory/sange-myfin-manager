# Existing Firebase data extraction — 12 September 2026

The owner-authorized read-only export of `myfinmanager-1d2da` completed at 12:50:23 UTC. No source documents, authentication accounts, bucket objects, rules or production routes were changed.

| Collection | Records |
| --- | ---: |
| Companies | 8 |
| Application users | 8 |
| Clients | 12 |
| Products | 9 |
| Transactions | 52 |
| Expenses | 3 |
| Activities | 26 |
| **Firestore total** | **118** |

Nine Firebase Authentication metadata profiles were exported using an explicit field allowlist. Password hashes, salts, refresh tokens, access tokens and Firebase download-token metadata were excluded. All eight application user IDs have corresponding authentication profiles; one authentication profile has no application user. No accounts have been linked by email or given new credentials.

Firestore was enumerated recursively, including missing parent documents and subcollections, at fixed read time `2026-09-12T12:50:16.195Z`. No nested collections or missing-parent placeholders were found. Typed Firestore JSON preserves timestamps and integer encodings. Authentication and Storage were read separately while the old application remained writable; this is not a production cutover snapshot.

The configured bucket `myfinmanager-1d2da.firebasestorage.app` contains zero current objects. Eight image data URLs are embedded in the exported documents and remain in that protected raw data. No Firebase Storage download URLs were found in the documents.

## Protected artifacts

Canonical protected copy on nexus-pbund:

`/root/myfin-jobs/phase04-management-20260912/private/private-myfin-export-20260912/`

The directory is root-only (0700), files 0600. A second copy remains in the originating Windows user's private task directory with inheritance removed and access limited to that Windows identity and SYSTEM. Neither copy is under Git, deployed to the application, or publicly served. The existing Firebase CLI authorization remained on the originating computer; it was not copied to a server.

`report.json` records SHA-256 digests and sizes for `firestore.ndjson`, `auth-users.json`, and `storage-objects.json`. The server copy was checked against every recorded size and digest. `inventory.json` contains counts and structural exceptions only. Redacted receipts are available under the Phase04 `reports/` directory.

## Reconciliation before PostgreSQL import

Extraction is complete. Loading the historical business data into the new application's live development database is a separate migration step, not part of this export.

- All nonempty company references resolve to one of the eight exported Firestore company document IDs.
- Two client documents and two transaction documents contain an `id` field different from their document path ID. The document path is authoritative; retain the embedded value as provenance and reconcile references explicitly.
- One historical transaction lacks type and total. Preserve it for review; do not guess financial values or silently drop it.
- Transaction types include 30 invoices, 18 quotes, two payment vouchers, one expense, and one unspecified record. Preserve source type and status rather than treating everything as a POS receipt.
- Twenty-three historical activities have no actor ID; two are global with no company. Preserve their recorded actor text without falsely assigning them to the migration operator.
- The standalone expenses and the expense transaction need lineage checks before combining them.
- Normalize legacy company/profile preferences with `taxRate` taking precedence over older `tax` when both exist. Preserve embedded logo and QR assets.
- Preserve Firebase UID and document ID mappings, reconcile the unassigned authentication profile explicitly, and provision local login credentials through a separate controlled account process. Existing Firebase passwords are not portable as local Better Auth passwords.
- Rehearse an idempotent import into an isolated database, compare record counts and monetary totals, reconcile every exception, and test private file ownership before loading the existing development database. Never replay checkout to recreate historical transactions or reduce current stock twice.

Production Firebase remains the source of truth until a separately verified cutover. The Phase04 management release operates on the existing development data.
