# Company Management

## Purpose

Manages companies, active company selection, company profile data, branding assets, preferences, and super-admin company operations.

## Source Files

- `src/components/SuperDashboard.vue`
- `src/components/super/CompanyModal.vue`
- `src/components/dashboard/CompanyManager.vue`
- `src/store/companies.js`
- `src/composables/useStorage.js`

## Data Model

Firestore collection: `companies`

Common fields:

- `name`
- `registration`
- `address`
- `phone`
- `email`
- `logo`
- `qrCode`
- `preferences`

Common preferences:

- `currency`
- `tax`
- `theme`
- `baseTheme`
- `primaryColor`
- document label settings

## Company Selection

- `Store.selectCompany(company)` sets `Store.state.selectedCompany`.
- Selecting a company starts company-scoped realtime listeners for products, transactions, expenses, and clients.
- `super` users can select companies from `SuperDashboard.vue`.
- `company_user` and `company_admin` users are auto-selected to their assigned company when companies load.

## Company CRUD

- `companiesModule.addCompany()` writes a new company document.
- `companiesModule.updateCompany()` strips `id` and updates the existing company document.
- `companiesModule.deleteCompany()` deletes a company document.

## Branding Assets

- `CompanyManager.vue` uses `useStorage().optimizeImage()` for logos.
- It uses `useStorage().extractQRCode()` for QR payment screenshots.
- `CompanyModal.vue` has its own image and QR handling code for super-admin company creation/editing.

## Preferences

- `companiesModule.updatePreferences()` updates local `Store.state.preferences`.
- If a company is selected, it writes preferences to `companies/{id}`.
- `Store.saveCompanyStyle()` is an alias for `Store.updatePreferences()`.

## UI Rules

- Company profile editing lives in `/companies`.
- Super-admin company creation/editing lives in `SuperDashboard.vue` and `CompanyModal.vue`.
- Keep logo and QR uploads optimized; avoid storing huge base64 payloads.

## Agent Notes

- Company deletion does not cascade through users, products, transactions, expenses, or clients.
- `CompanyModal.vue` duplicates image-processing logic that also exists in `useStorage.js`.
- POS QR payment currently checks `company.qrCodeUrl`, while company settings save `qrCode`. Verify this field before changing QR payment behavior.
