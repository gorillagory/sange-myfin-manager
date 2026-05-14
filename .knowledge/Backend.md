# Backend Rule

Read this before changing Firebase, auth, storage, Firestore data, store modules, permissions, or persistence behavior.

## Pre-change Gate

- Check `git status --short` before edits. This repo may already contain user changes; never revert unrelated work.
- Identify whether the change affects auth state, selected company state, Firestore data shape, Storage files, or role permissions before editing.
- Preserve company boundaries. Any company-owned data must be scoped by `company_id` and the active company from `Store.state.selectedCompany`.
- Run `npm run build` after code changes when feasible.

## Required Understanding

There is no separate backend service in this repo. Backend behavior is Firebase client SDK usage from the browser.

- Firebase is initialized in `src/firebase.js` from `VITE_FIREBASE_*` environment variables and exports `db`, `auth`, and `storage`.
- Firestore, Auth, and Storage calls should usually live in `src/store/*` modules or composables, not scattered through UI components.
- The central store is `src/store/index.js`, exported as a reactive `Store`. It wraps modules from:
  - `src/store/finance.js`
  - `src/store/inventory.js`
  - `src/store/companies.js`
  - `src/store/auth.js`
- Components commonly call wrapper methods such as `Store.addTransaction`, `Store.updateProduct`, `Store.addClient`, or module methods that accept `Store` as the first argument.
- Realtime data is loaded through `onSnapshot` listeners in `Store.startListeners()` and `Store.startCompanyDataListeners(companyId)`.
- Company-scoped collections currently include `products`, `transactions`, `expenses`, and `clients`; queries filter by `company_id`.
- Every create/update for company-owned records must set or preserve `company_id`. Never save cross-company records by accident.
- Clean data before Firestore writes. Existing modules use `JSON.parse(JSON.stringify(...))`, destructuring, and explicit numeric conversion to avoid Vue proxies and stringified numbers.
- Respect roles:
  - `super`
  - `company_admin`
  - `company_user`
- Destructive actions are expected to honor `Store.canDelete()` where applicable. The router guard and UI hiding are convenience checks, not a complete security model.
- Current `firestore.rules` allows all reads/writes. Do not assume production-grade backend enforcement unless rules are changed as part of the task.
- Firebase Storage concerns belong in `src/composables/useStorage.js`. It handles upload, delete, image optimization, and QR extraction.
- PDF generation belongs in `src/composables/usePdfGenerator.js` and depends on DOM readiness plus `html2pdf.js`.
