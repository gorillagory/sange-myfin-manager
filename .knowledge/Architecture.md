# Architecture

Read this before changing app structure, routing, feature ownership, state management, or module boundaries.

## Pre-change Gate

- Check `git status --short` before edits. This repo may already contain user changes; never revert unrelated work.
- Identify whether the change affects auth flow, company selection, routing, central state, Firestore listeners, or feature ownership before editing.
- Prefer small, local changes that follow existing patterns. This app is not using Pinia, Vuex, a backend API server, or a component library.
- Run `npm run build` after code changes when feasible.

## Required Understanding

The app is organized as a client-side Vue dashboard with a global reactive store and lazy-loaded route screens.

- Entry points:
  - `src/main.js` creates the Vue app, installs the router, and mounts `App`.
  - `src/App.vue` renders the active top-level experience based on `Store.state.currentUser` and `Store.state.selectedCompany`.
  - `src/router/index.js` defines tab routes and admin route metadata.
- Main experiences:
  - `AuthManager.vue`: login form.
  - `SuperDashboard.vue`: super-admin company/user command center before selecting a company.
  - `DashboardManager.vue`: company workspace shell with sidebar navigation.
- Route tabs are intentionally feature-oriented:
  - Overview, POS, Analytics, Contacts, Sales, Expenses, Products, Profile.
  - Admin-only tabs: Companies/Settings, Users, Activity, Templates, Preferences.
- Larger features are split into subcomponents:
  - POS parts live in `src/components/dashboard/pos/`.
  - Product editor/list parts live in `src/components/dashboard/products/`.
  - Sales parts live in `src/components/dashboard/finance/sales-parts/`.
  - Document templates live in `src/components/dashboard/docdesign/`.
- Keep domain logic near its current owner:
  - Finance documents, clients, expenses, and project batching in `finance.js`.
  - Products, variants, stock, and inventory mutations in `inventory.js`.
  - Company profile/preferences in `companies.js`.
  - User profile/auth management in `auth.js`.
- Be careful with initialization and listeners. The app already initializes store/auth listeners during startup; do not add duplicate global listeners without first checking lifecycle and unsubscribe needs.
- The data model is flat Firestore collections with `company_id` references rather than nested company subcollections.
- Route protection is role metadata plus a `beforeEach` guard. Sidebar visibility should stay consistent with route metadata.
- Avoid large architecture swaps unless explicitly requested. A change that introduces Pinia, server APIs, new routing structure, or a design system must be treated as a major migration.
