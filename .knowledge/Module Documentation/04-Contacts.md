# Contacts

## Purpose

Manages client and supplier contacts used by sales documents and client-specific sales views.

## Source Files

- `src/components/dashboard/ContactsTab.vue`
- `src/components/dashboard/finance/sales-parts/ClientDirectory.vue`
- `src/store/finance.js`
- `src/store/index.js`

## Data Model

Firestore collection: `clients`

Common fields:

- `id`
- `company_id`
- `name`
- `phone`
- `type`

`type` is usually:

- `Client`
- `Supplier`

## Data Flow

- `Store.startCompanyDataListeners(companyId)` loads `clients` filtered by `company_id`.
- `ContactsTab.vue` filters `Store.state.clients` again by active company.
- `Store.addClient()` delegates to `financeModule.addClient()`.
- `financeModule.addClient()` uses `setDoc()` when an id exists and `addDoc()` otherwise.
- `Store.deleteClient()` delegates to `financeModule.deleteClient()`.

## Sales Integration

- `SalesTab.vue` filters `clients` by active company.
- `ClientDirectory.vue` searches clients by name and emits selected client state to `SalesTab.vue`.
- Sales documents store the selected contact id as `client_id`.

## UI Rules

- Contact create/edit uses a modal inside `ContactsTab.vue`.
- Do not mutate table rows directly; clone the contact into `clientForm` before editing.
- Use `Store.notify()` after save/delete.

## Agent Notes

- The Firestore collection is named `clients`, but the UI represents both clients and suppliers.
- `deleteClient()` returns a notification instead of throwing when access is denied.
- If adding richer contact fields, update both contact screens and document client lookup behavior.
