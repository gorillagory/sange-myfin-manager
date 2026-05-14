# Expenses

## Purpose

Tracks spending, expense categories, receipt uploads, receipt deletion, and expense totals.

## Source Files

- `src/components/dashboard/ExpensesTab.vue`
- `src/store/finance.js`
- `src/composables/useStorage.js`

## Data Shape

Expense form fields:

- `id`
- `company_id`
- `date`
- `description`
- `category`
- `amount`
- `receiptUrl`
- `receiptPath`
- `type`

## UI Flow

- `ExpensesTab.vue` has two modes:
  - `list`
  - `editor`
- List mode shows active-company expenses, total spend, receipt links, edit, and delete.
- Editor mode validates description and amount, then saves.

## Receipt Flow

- File selection is limited to 5MB in the UI.
- Receipt files are uploaded through `useStorage().uploadFile()`.
- Upload path is `receipts/{companyId}/{timestamp}_{filename}`.
- Replacing a receipt removes the old `receiptPath` first.
- Deleting an expense removes the receipt file before deleting the transaction.

## Store Flow

Current `ExpensesTab.vue` saves expenses through transaction methods:

- new expense: `Store.financeModule.addTransaction(Store, form)`
- update expense: `Store.financeModule.updateTransaction(Store, { ...form, type: 'Expense' })`
- delete expense: `Store.deleteTransaction(expense.id)`

`finance.js` also contains separate `addExpense()` and `deleteExpense()` methods for the `expenses` collection.

## UI Rules

- Use `SmartButton` for delete confirmation.
- Keep upload progress/loading state through `isUploading`.
- Keep receipt cleanup paired with expense deletion.

## Agent Notes

- There are two competing persistence models:
  - `transactions` collection with `type: 'Expense'` used by `ExpensesTab.vue`.
  - `expenses` collection methods in `financeModule`.
- `ExpensesTab.vue` lists from `Store.state.expenses`, but saves to `transactions`. Verify the intended model before fixing or extending expenses.
- Analytics currently reads both `transactions` and `expenses` in different ways, so changing expense storage affects reporting.
