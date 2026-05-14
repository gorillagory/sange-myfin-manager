# Authentication And Users

## Purpose

Handles login, logout, user profile loading, user creation, user editing, staff management, and self profile updates.

## Source Files

- `src/components/AuthManager.vue`
- `src/components/SuperDashboard.vue`
- `src/components/super/UserModal.vue`
- `src/components/dashboard/UserManager.vue`
- `src/components/dashboard/UserProfile.vue`
- `src/store/auth.js`
- `src/store/index.js`

## Data Model

Firestore collection: `users`

Common fields:

- `username`
- `email`
- `role`
- `company_id`

Roles:

- `super`
- `company_admin`
- `company_user`

## Login Flow

- `AuthManager.vue` collects email/username and password.
- It calls `Store.login(email, password)`.
- `Store.login()` uses Firebase Auth `signInWithEmailAndPassword`.
- `Store.init()` later loads the matching Firestore user by email and sets `Store.state.currentUser`.

## User Creation

- `authModule.addUser(store, userData)` creates Firebase Auth accounts through a secondary Firebase app.
- It writes the profile to `users/{uid}` using the created Firebase Auth UID.
- Password is required for new users.
- Email is not updated in edit mode because Firebase Auth email changes require separate handling.

## User Editing

- `authModule.updateUser()` updates Firestore profile fields only.
- It excludes `id`, `password`, and `email` from the update payload.
- `UserManager.vue` filters users to the active company.
- `SuperDashboard.vue` can manage users across all companies.

## Self Profile

- `UserProfile.vue` lets the current user update display name and optionally password.
- `authModule.updateSelf()` calls Firebase `updatePassword()` if a new password is provided.
- Recent-login errors are surfaced through `Store.notify()`.

## UI Rules

- Keep company staff management under `/users`.
- Keep super-admin global user management in `SuperDashboard.vue`.
- Do not show password fields when editing an existing user.
- Use role names consistently with router/admin checks.

## Agent Notes

- `AuthManager.vue` currently does not `await` `Store.login()`, so its loading-state logic may not behave as intended.
- `UserManager.vue` calls `Store.resetUserPassword()`, but no such method exists in the current `Store`. Add or repair this before enabling password reset UX.
- Deleting a user removes the Firestore user document but does not delete the Firebase Auth account from client code.
