# Sales And Documents

## Purpose

Manages quotes, invoices, receipts/paid invoices, client-specific sales views, project grouping, document editing, document status changes, conversion, and PDF downloads.

## Source Files

- `src/components/dashboard/finance/SalesTab.vue`
- `src/components/dashboard/finance/sales-parts/ClientDirectory.vue`
- `src/components/dashboard/finance/sales-parts/SalesStats.vue`
- `src/components/dashboard/finance/sales-parts/SalesTable.vue`
- `src/components/dashboard/finance/sales-parts/SalesEditor.vue`
- `src/components/dashboard/finance/sales-parts/SalesProjectDrawer.vue`
- `src/components/dashboard/docdesign/TemplateClean.vue`
- `src/components/dashboard/docdesign/TemplateCorporate.vue`
- `src/components/dashboard/docdesign/TemplateModern.vue`
- `src/store/finance.js`
- `src/composables/usePdfGenerator.js`

## Data Model

Firestore collection: `transactions`

Common sales fields:

- `id`
- `company_id`
- `client_id`
- `project`
- `type`
- `number`
- `date`
- `status`
- `items`
- `subtotal`
- `total`
- `taxRate`
- `discount`
- `notes`

Types:

- `Invoice`
- `Quote`

Statuses:

- `Pending`
- `Cleared`
- `Converted`

## Sales Dashboard

- `SalesTab.vue` controls dashboard/editor mode.
- `ClientDirectory.vue` filters sales by selected client.
- `SalesStats.vue` displays billed, collected, outstanding, and open quote metrics.
- `SalesTable.vue` separates tabs:
  - invoice: unpaid invoices.
  - receipt: cleared invoices.
  - quote: quotes.

## Document Creation And Editing

- `handleNewInvoice(type)` builds a default `txForm`.
- Quotes get `QT-` numbers; invoices get `INV-` numbers.
- Line items default to service-style rows.
- `SalesEditor.vue` renders the active document template into `#invoice-print-area`.
- Templates directly mutate `txForm` via props for line editing.

## Save Flow

- `saveTx()` calculates subtotal and total.
- New docs get `id = Date.now().toString()`.
- New docs call `Store.addTransaction()`.
- Existing docs call `Store.updateTransaction()`.

## Status Flows

- Mark paid: updates invoice `status` to `Cleared`.
- Convert quote: creates a new invoice copied from the quote, then marks quote `Converted`.
- Delete: calls `Store.deleteTransaction()`.

## Project Grouping

- `SalesTable.vue` lets users select documents or filter by project.
- `SalesProjectDrawer.vue` calculates paid, due, pipeline, and total project value.
- `Store.assignProject()` uses Firestore batch updates.

## PDF Flow

- `handleDownload()` switches to editor mode, sets `isGeneratingPdf`, and calls `usePdfGenerator().generatePdf()`.
- PDF generation captures `#invoice-print-area` with `html2pdf.js`.
- Templates use `isPdf`, `.pdf-mode`, and `no-print` to change rendering.

## Agent Notes

- `saveTx()` checks `!client_id && type !== 'Invoice'`, meaning invoices can be saved without a client but quotes cannot. Verify whether this is intended before changing validation.
- `SalesEditor.vue` computes `tax` as `total - sub`, which includes discount effects; this may not represent raw tax amount.
- Project analytics intentionally ignore converted quote values to avoid double counting.
