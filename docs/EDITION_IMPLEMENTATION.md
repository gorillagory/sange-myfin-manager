# Edition implementation

Edition is now the application interface, connected to the existing Firebase
project and existing collection names. The design lab remains an independent
historical preview. No demo records are loaded by the production application.

## Connected screens

The sign-in screen, workspace selection, navigation, overview, checkout, sales,
inventory, contacts, expenses, analytics, team, store profile, preferences,
document templates, user profile and activity use the Edition visual system.
The existing invoice, quote, project grouping, product variant, staff management,
company logo/QR and PDF document tools are retained.

Overview and analytics share the interpretation of both historical `Paid` and
`Cleared` invoices. Expenses show canonical expense records and legacy expenses
from transactions, while saving edits back to their original collection. New
expenses use `expenses.amount`. These adapters do not rewrite historical records.

## Checkout behavior

- Amounts round in integer cents at line, discount and tax boundaries.
- Product/variant IDs, unit, SKU, prices, tender and receipt identity are retained.
- A random stable sale ID is reused for retries. A Firestore transaction commits
  the sale, stock changes, stock movement record and activity together.
- Completed POS receipts cannot be edited or deleted. Invoice/quote editing stays
  available for the existing finance workflow. Project grouping remains editable.
- Cash payment requires sufficient tender; QR/card require external confirmation.
- Receipt details snapshot the store's details at checkout. Reprint opens the
  original transaction without performing another sale. Both 58 and 80 mm widths
  are supported through browser printing and the printer's own paper settings.
- An IndexedDB transaction saves the payment and clears its durable cart together.
  Failed local storage leaves the cart open; no payment success is reported.
- Carts and held orders are partitioned by user/company/browser tab and survive
  navigation and refresh in that tab. Keep the checkout tab open while an order is
  held. Pending receipts remain recoverable across tabs on the originating device.
- A delayed cloud response shows **Saved on this device / Awaiting sync**, never
  cloud success. Reconnect or the Retry sync action posts the same ID again.
- Online stock checks reject overselling. Accepted offline sales are preserved
  even if combined stock becomes negative, with a visible shortage flag. Other
  sync failures remain in the recovery queue for review/retry; do not collect
  payment again. An export of pending receipts is available from the queue.

## Access and sessions

Authentication initializes once. UID profile snapshots control membership, and
company/auth listener cleanup prevents stale callbacks from replacing another
store's data. Store selection survives refresh per user. Preference updates merge
individual fields instead of erasing tax or document settings.

Before changing rules, a read-only comparison found that all seven existing
profiles matched their Firebase Authentication UID and email (eight Auth accounts
in total; one had no profile). No account or business record was migrated.

Firestore rules require membership, scope company records, prevent self-elevation,
restrict deletion to managers and protect posted POS receipts. Storage rules use
the same membership for receipt attachments and restrict new uploads to images or
PDFs of at most 5 MB. Existing token-bearing download links retain their usual
Firebase behavior. Direct document clients are still trusted for catalog editing
and invoice amounts; this is not a server-authoritative payment processing system.

## Offline installation

The build generates a versioned service worker that caches the app shell, route
chunks and styles. Icons use local inline SVGs, so no icon font download is needed. Business data is not cached by that worker;
Firestore's persistent cache and the POS IndexedDB stores handle those records.
First sign-in and loading an uncached store require a connection. External QR/card
devices require their own payment connectivity. Keep browser data while receipts
are unsynced. This is not a substitute for an off-device database backup.

## Validation commands

```sh
npm test
firebase emulators:start --only auth,firestore,storage --project demo-myfin-edition --config firebase.emulator.json
node scripts/seed-edition-emulator.mjs
npm run test:firebase
npm run build
node --test tests/service-worker.test.mjs
```

The fixture script is hard-coded to loopback addresses and `demo-myfin-edition`.
It never writes the production project. Start Vite with `VITE_USE_EMULATORS=true`
for browser tests; this switch is gated by Vite's development flag and omitted
from the production build.

The automated suite covers rounding, tender validation, legacy adapters, variants,
service items, stock shortage policy, idempotent retries, concurrent last-item
sales, tenant boundaries, role elevation, immutable posted receipts and expenses.
Browser checks and deployment results are recorded in the release notes below.

## Operational boundaries

Printer hardware, cutter/cash-drawer commands, external payment terminals and a
complete physical shop shift require testing on the actual devices. Barcode
scanning remains deferred as requested. Refunds/returns, register shifts and cash
drawer reconciliation were not existing complete workflows and are not added by
the Edition interface rollout. The database backup/restore arrangements from the
readiness assessment still need to be established before relying on it for trading.

## Release validation — 10 September 2026

- Production build passed. Remaining build warnings concern bundle size and a
  shared static/dynamic profile import; they do not prevent deployment.
- All 16 tests passed: seven domain tests and nine Firebase emulator tests,
  including concurrent tills, variant/service deductions and Storage rules.
- Browser checks used emulator data only. Cash tender validation, change,
  successful receipts and reprint passed. A deliberately interrupted backend
  preserved a pending payment across refresh; reconnect synced that same ID.
- Product creation appeared at checkout. Cart refresh, held-order recovery,
  customer creation, expense create/edit, preference save/reload, teammate
  creation, quote conversion and invoice PDF export passed through the UI.
- Desktop and 390 px phone layouts were checked. All 13 workspace routes loaded;
  checkout and the remaining screens had no page-level horizontal overflow.
- Production Auth/profile compatibility and the default Storage bucket were
  checked read-only. No test users or test sales were written to production.
- Updated vulnerable dependencies, including the PDF libraries, and checked PDF
  export afterward. `npm audit` reports zero known vulnerabilities.
- Four generated-service-worker tests verify installation, network-error and
  gateway-error fallback, and exclusion of Firebase traffic/outgoing writes.
- The app now registers its offline shell immediately and displays device cache
  readiness. The embedded test browser showed cache readiness but a blank page on
  automated navigation after stopping the local web server. A full offline browser
  restart is therefore **not confirmed**; test it on the shop browser before use.

Hosting, Firestore rules and Storage rules were released successfully. The hosted
HTML matched the release build; `/sw.js` returned HTTP 200 with `no-cache`, and an
anonymous production Firestore request was denied with HTTP 403.

The production Firebase project is `myfinmanager-1d2da`; the application uses its
existing Authentication, Firestore and default Storage bucket. Deploy with
`firebase deploy --only hosting,firestore:rules,storage --project myfinmanager-1d2da`.
Deploying this release does not seed, migrate or delete business records.
