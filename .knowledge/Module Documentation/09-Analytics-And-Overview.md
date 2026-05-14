# Analytics And Overview

## Purpose

Provides dashboard summary cards, recent activity summaries, daily business intelligence, weekly trend charts, and top product analysis.

## Source Files

- `src/components/dashboard/OverviewTab.vue`
- `src/components/dashboard/AnalyticsTab.vue`

## Overview Module

`OverviewTab.vue` shows:

- total revenue
- total expenses
- net profit
- margin
- financial health progress bars
- recent activity

It computes values from `Store.state.transactions` filtered by active `company_id`.

Income logic:

- `type === 'Invoice'`

Expense logic:

- `type === 'Expense'`
- `type === 'Payment Voucher'`

## Analytics Module

`AnalyticsTab.vue` shows:

- today's gross revenue
- today's expenses
- today's net profit
- profit growth vs yesterday
- 7-day net profit trend
- top performing products

Revenue logic:

- transactions with `status === 'Paid'` for daily/weekly stats.

Top products logic:

- transactions with `status === 'Paid'`
- totals item quantities and revenue from transaction `items`.

## UI Rules

- Keep overview summary concise and dashboard-oriented.
- Keep analytics read-only; mutations belong in sales, POS, expenses, products, or store modules.
- Use active company currency from `selectedCompany.preferences.currency`.

## Agent Notes

- Status names differ across modules: POS and sales use `Cleared`, while `AnalyticsTab.vue` checks `Paid`. This can cause analytics to miss current sales.
- `AnalyticsTab.vue` uses `Store.state.expenses`, while `OverviewTab.vue` treats expenses as transaction types.
- Always verify the intended expense and status model before changing analytics formulas.
