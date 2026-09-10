# MyFin design lab

Two interactive alternatives for choosing a UI direction before integrating it
into the Vue application. Published on the existing Firebase Hosting site.

## Entry points

- `/design-lab/index.html`: comparison gallery and device-local preference.
- `/design-lab/edition.html`: forest, paper and editorial typography; left navigation.
- `/design-lab/signal.html`: cobalt and midnight; horizontal navigation and connected grids.
- Append `#kit` to either design for the component kitchen sink or `#pos` for checkout.

Each direction includes overview, checkout, sales, inventory, contacts, expenses,
team, settings, activity, and a component kitchen sink. Shared interaction code
keeps workflows comparable while theme styles change layout, density and type.

## Preview behavior

Products, cart quantities and variants, held orders, customer selection, cash/QR/card
confirmation, receipt preview, sale history, sample product/contact/expense/team
forms, settings, profile edits, and CSV exports can be explored in the browser.
Cash values use integer cents. Cash checkout validates the amount received and
calculates change; QR and card require an illustrative external confirmation.
Native dialogs provide focus containment and Escape dismissal. Checkout also
offers product search, keyboard shortcuts, and a mobile cart shortcut.

The module has no Firebase imports or network calls. Business records are fictional
and held in memory; refreshing resets them. The gallery stores only a design
preference in localStorage. No invitations, payments, or live database writes occur.
Overview metrics are illustrative, rather than a reconciled report over sample sales.
Offline status demonstrates appearance only; there is no durable offline queue.
Receipt printing uses a browser print stylesheet targeting 80 mm paper; selecting
other widths in settings is illustrative. Hardware printing was not tested.

These previews do not fix the production POS defects documented in
`POS_READINESS.md`. Existing authentication and dashboard screens link to the
gallery in a new tab so a current cart remains open.

## Implementation and validation

Static files under `public/design-lab/` are copied to `dist/design-lab/` by Vite.
There are no added dependencies. Firebase's existing static hosting serves these
files alongside the Vue application; no hosting configuration changes are needed.

Browser checks covered desktop visual layout, all ten views in both directions at
390 px width, the mobile drawer/cart shortcut, cash amount rejection and change,
QR confirmation rejection and completion, SKU search, settings-to-receipt updates,
and the comparison gallery. No browser console errors appeared during these checks.

Build and deploy with:

```sh
node --check public/design-lab/app.js
npm run build
firebase deploy --only hosting --project myfinmanager-1d2da --non-interactive
```

Deploy Hosting only. Firestore rules, indexes, and records are outside this design
deployment. A chosen direction still needs to be integrated into the live Vue views.
