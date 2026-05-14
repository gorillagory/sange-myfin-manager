# Settings And Profile

## Purpose

Handles app appearance preferences, current user profile editing, and password updates.

## Source Files

- `src/components/dashboard/SettingsTab.vue`
- `src/components/dashboard/UserProfile.vue`
- `src/components/DashboardManager.vue`
- `src/store/companies.js`
- `src/store/auth.js`

## Settings

`SettingsTab.vue` manages:

- `theme`
- `docTemplate` default in local temp state

Theme options:

- `light`
- `dark`
- `auto`

`applyTheme(theme)` toggles `document.documentElement.classList` with `dark`.

## Preference Save Flow

- `SettingsTab.vue` calls `Store.updatePreferences(tempPrefs.value)`.
- `companiesModule.updatePreferences()` updates `Store.state.preferences`.
- If a company is selected, preferences are written to `companies/{id}`.

## Profile

`UserProfile.vue` manages:

- display name
- new password
- confirm new password

Save flow:

- validates password confirmation.
- calls `Store.updateSelf({ username, password })`.
- clears password fields on success.

## Shell Theme Application

`DashboardManager.vue` applies theme preferences on mount.

## Agent Notes

- `SettingsTab.vue` loads from `Store.state.preferences`, while many modules read `Store.state.selectedCompany.preferences`.
- `theme: auto` is based on local hour, not system color preference.
- Password changes can fail with `auth/requires-recent-login`; current behavior asks users to log out and back in.
