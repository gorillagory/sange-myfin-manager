# Store And State

## Purpose

Provides the global reactive state, Firebase realtime listeners, module wrappers, notifications, permissions, and company selection.

## Source Files

- `src/store/index.js`
- `src/store/state.js`
- `src/store/auth.js`
- `src/store/companies.js`
- `src/store/finance.js`
- `src/store/inventory.js`
- `src/firebase.js`

## Core Shape

`Store` is a Vue `reactive` object, not Pinia or Vuex.

Main state fields:

- `companies`
- `selectedCompany`
- `transactions`
- `expenses`
- `clients`
- `products`
- `users`
- `currentUser`
- `activities`
- `notification`
- `preferences`
- `isLoading`

## Initialization

- `Store.init()` subscribes to Firebase Auth with `onAuthStateChanged`.
- On authenticated user, it queries `users` by email and sets `Store.state.currentUser`.
- User preferences are copied to `Store.state.preferences` when present.
- `Store.startListeners()` attaches realtime listeners for `companies` and `users`.
- `Store.startCompanyDataListeners(companyId)` attaches realtime listeners for company-scoped collections:
  - `products`
  - `transactions`
  - `expenses`
  - `clients`

## Company Scoping

Company-owned records are flat Firestore documents with a `company_id` field. The app queries by `company_id` rather than nested company subcollections.

Always preserve or set `company_id` for:

- products
- transactions
- expenses
- clients
- company-assigned users

## Module Wrappers

The main store exposes shortcut methods:

- transactions: `addTransaction`, `updateTransaction`, `deleteTransaction`, `assignProject`
- products: `addProduct`, `updateProduct`, `deleteProduct`
- expenses: `addExpense`, `deleteExpense`
- clients: `addClient`, `deleteClient`
- companies: `addCompany`, `updateCompany`, `deleteCompany`
- users: `addUser`, `updateUser`, `deleteUser`, `updateSelf`
- preferences: `updatePreferences`, `saveCompanyStyle`

## Notifications

Use `Store.notify(message, type)` for UI messages.

- default type: `success`
- error type: `error`
- notification hides after 3 seconds.

## Permission Helpers

- `Store.canDelete()` returns true for `super` and `company_admin`.
- Destructive module methods should use this helper where applicable.

## Agent Notes

- Existing listeners are not unsubscribed when switching companies. Be careful adding new `onSnapshot` listeners because duplicate subscriptions can accumulate.
- Some module methods call modules through wrappers; other components call module methods directly with `Store` as the first argument. Match the local pattern.
- Clean Vue reactive data before Firestore writes. Existing code often uses `JSON.parse(JSON.stringify(...))`.
- `Store.logActivity()` currently logs to console only; `Store.state.activities` is not populated by this helper.
