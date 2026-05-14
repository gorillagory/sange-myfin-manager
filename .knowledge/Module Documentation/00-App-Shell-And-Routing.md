# App Shell And Routing

## Purpose

Owns app startup, top-level view selection, dashboard navigation, route loading, and admin route protection.

## Source Files

- `src/main.js`
- `src/App.vue`
- `src/router/index.js`
- `src/components/DashboardManager.vue`
- `src/components/CompanySelector.vue`

## Runtime Flow

- `src/main.js` imports global CSS, creates the Vue app, installs the router, calls `Store.init()`, and mounts `App`.
- `src/App.vue` decides the top-level experience:
  - no `Store.state.currentUser`: show `AuthManager`.
  - `super` user with no selected company: show `SuperDashboard`.
  - all other authenticated states: show `DashboardManager`.
- `DashboardManager.vue` renders the company workspace shell:
  - dark slate top navigation.
  - responsive sidebar / mobile drawer.
  - admin-only route links.
  - `router-view` for dashboard tabs.
- `src/router/index.js` lazy-loads route components and uses `meta.requiresAdmin` for protected tabs.

## Routes

- `/overview`
- `/pos`
- `/analytics`
- `/contacts`
- `/sales`
- `/expenses`
- `/products`
- `/profile`
- `/companies` admin only
- `/users` admin only
- `/activity` admin only
- `/templates` admin only
- `/settings` admin only

## State Dependencies

- `Store.state.currentUser`
- `Store.state.selectedCompany`
- `Store.state.preferences`
- `Store.state.notification`
- `Store.state.isLoading`

## Permission Rules

- Admin route access is checked by `router.beforeEach`.
- Admin users are `super` and `company_admin`.
- Sidebar visibility and route metadata should stay aligned.
- The guard is UI/client-side only; do not treat it as backend security.

## UI Rules

- Keep `DashboardManager.vue` responsible for workspace shell layout.
- Add new dashboard screens through `src/router/index.js` and the sidebar together.
- Preserve the mobile drawer behavior and `md:` breakpoint assumptions.
- Use `Store.notify()` for route access errors.

## Agent Notes

- `CompanySelector.vue` appears legacy or inactive in the current top-level flow; `App.vue` sends super users to `SuperDashboard` instead.
- `Store.init()` is called in both `src/main.js` and `App.vue` `onMounted()`. Be careful before adding more initialization calls or listeners.
- Do not introduce a new router/state architecture unless the task explicitly calls for a migration.
