# UI/UX Rule

Read this before changing screens, components, routes, visual layout, PDF output, or interaction behavior.

## Pre-change Gate

- Check `git status --short` before edits. This repo may already contain user changes; never revert unrelated work.
- Identify whether the change affects auth state, selected company state, routing, PDF output, or responsive UI before editing.
- Prefer small, local changes that follow existing patterns. This app is not using a component library.
- Run `npm run build` after code changes when feasible.

## Required Understanding

The UI is a Vue 3 + Vite dashboard application built with single-file components and Tailwind utilities.

- Use `<script setup>` and Composition API patterns. Existing screens derive display state with `ref` and `computed` from the central `Store`.
- Keep the dashboard-first product shape. Do not turn app screens into marketing/landing pages; this is an operational finance/POS/admin tool.
- Match the existing dense business UI: top nav, left sidebar, tables, modals, drawers, compact stat cards, and form panels.
- Respect the shell split:
  - `src/App.vue` decides auth vs super dashboard vs company dashboard.
  - `src/components/DashboardManager.vue` owns the top nav, sidebar, mobile drawer, admin links, and `router-view`.
  - Route screens live under `src/components/dashboard/`.
- Use Tailwind classes in templates for local styling. Global CSS in `src/style.css` is mostly for document templates, PDF mode, print behavior, and shared transitions.
- Preserve dark mode classes where a surface already supports them. Dark mode is applied by toggling `document.documentElement.classList`.
- Use Font Awesome icon classes because `index.html` loads Font Awesome. Do not introduce a second icon system for routine buttons.
- Use `Store.notify(message, type)` for toasts instead of creating separate notification mechanisms.
- Use `SmartButton` for destructive or confirmation-style inline actions where it fits the existing UX.
- Keep PDF and print behavior intact. Respect `no-print`, `.pdf-mode`, document template classes, and `#invoice-print-area` assumptions.
- Ensure mobile behavior remains usable: sidebar is a drawer on small screens, core dashboards use responsive grids, and POS/cart views rely on fixed-height scroll regions.
