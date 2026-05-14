# Activity Audit

## Purpose

Displays activity/audit records and filters them by user role and active company.

## Source Files

- `src/components/dashboard/ActivityTab.vue`
- `src/store/index.js`

## Data Model

Expected activity fields:

- `id`
- `action`
- `details`
- `date`
- `user`
- `company`
- `company_id`

## Display Rules

- Super admins see all logs.
- Company admins see logs for the active company.
- Company filtering checks:
  - `log.company_id === selectedCompany.id`
  - fallback: `log.company === selectedCompany.name`

## UI Behavior

- Displays action icon and color based on action text:
  - contains `Delete`: red trash style.
  - contains `Create`: emerald plus style.
  - contains `Update`: blue info style.
  - fallback: gray info style.

## Store Integration

`Store.logActivity(action, details)` currently logs to the browser console only.

## Agent Notes

- There is no active Firestore listener for activities in `Store.startListeners()` or `Store.startCompanyDataListeners()`.
- `Store.state.activities` defaults to an empty array.
- If audit logging becomes real, add a Firestore collection, write path, listener, and security model together.
