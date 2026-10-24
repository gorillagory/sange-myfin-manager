# MyFin expense intelligence and claim reporting — 24 October 2026

**Status:** implementation candidate. This document describes the behavior in
the source candidate. A deployment receipt is complete only after the exact
source, migration, build, database checks, and authenticated browser acceptance
have passed in the target environment.

## Product boundary

The **Finance → Expenses → Insights & reports** view adds a live,
role-scoped view of expense accrual, settlement, evidence, ageing, claimant
attribution, payment sources, and petty-cash usage. It also produces an A4
aggregate PDF and, for canonical expense records, an individual claim PDF.
Existing expense entry, CSV, payment, reversal, void, receipt, and petty-cash
workflows remain the source records behind these reports.

The view starts at year-to-date and offers this month, this quarter,
year-to-date, and last-12-month presets. Users can apply an inclusive `from`
and `to` date and group the result by month, quarter, or year. A changed date or
grouping control does not alter the displayed result until **Apply** is used,
and the PDF action remains disabled while the controls differ from the applied
server result. Insights require a live connection; cached expense records stay
available in the ordinary expense list but are not used to invent an offline
analytics result.

All money is accumulated in integer sen. Totals that cannot be represented
exactly in JavaScript fail closed instead of being rounded.

## Reporting definitions

| Term | Implemented meaning |
| --- | --- |
| Posted claim count | Non-draft expense records whose expense date is inside the applied range. |
| Claims KPI | Posted claim count plus the separately displayed draft count. |
| Draft amount | Value of draft records in the range. It is planning information and is not posted. |
| Recorded | Full amount of posted claims dated in the range, regardless of whether cash has moved. This is the accrual view. |
| Paid | Net payment and reversal amount allocated to the in-range posted claims, using payment events on or before the report end date. It is capped between zero and the claim amount. |
| Outstanding | Recorded less paid as of the report end date. |
| Cash out | Net payment and reversal events whose payment occurrence date is inside the range. It can include settlement of an older claim and therefore need not equal **Paid** for the in-range accrual cohort. |
| Overdue | A posted claim with a positive outstanding balance and a real due date earlier than the report end date. A claim due on the end date is not overdue. |
| Ageing | Outstanding balance aged from its due date when present, otherwise from its expense date, to the report end date. Future due dates are **Not due**; remaining buckets are 0–7, 8–14, 15–30, 31–60, and 61+ days. |
| Receipt coverage | Posted claims with a stored receipt or attachment reference divided by posted claim count. Draft evidence is excluded. The report records only **Attached** or **Missing** and does not expose a private file path or URL. |
| Payment-source mix | Net payment events, including reversals, grouped by source and payment occurrence date. Supported sources are app user, named non-user, petty cash, bank, card, credit, other, and legacy/unspecified. |
| Claims by person | Attribution to the recorded creator of a canonical claim. This describes who submitted or created the claim, not who ultimately paid it. |
| Petty-cash claim disbursement | Net expense-payment events in the range whose source is petty cash. For company-scoped users, fund balances are reconstructed from ledger entries through the report end date while replenishments, spending, adjustments, counts, and reversals describe the selected period. |

Period rows are continuous across the applied range, including zero-value
months, quarters, or years. Categories and claimants show posted values and
draft values separately. The action queue contains at most the 20 oldest
outstanding records, ordered by age and then outstanding value.

## Roles and data scope

`expenseReportsRead` requires an active selected-company context and access to
the Finance module. Super admins and workspace owners receive the owner module
ceiling. Managers and operators must retain Finance in their effective module
grants.

| Capability | Super admin | Workspace owner | Manager with Finance | Operator with Finance |
| --- | --- | --- | --- | --- |
| Aggregate scope | Selected company | Selected company | Assigned selected company | Canonical rows whose recorded creator is the operator in the selected company |
| Claims-by-person table | Company scope | Company scope | Company scope | Hidden; the report is already self-scoped |
| Legacy Expense and Payment Voucher rows | Included when otherwise valid | Included when otherwise valid | Included when otherwise valid | Excluded because reliable claimant ownership is unavailable |
| Petty-cash claim payments | Company scope | Company scope | Company scope | Own claims only |
| Fund balances and fund movement summaries | Yes | Yes | Yes | No |
| Aggregate PDF | Company scope | Company scope | Company scope | Personal scope |
| Individual claim PDF | Any visible, currently non-void canonical claim in the selected company | Any visible, currently non-void canonical claim in the selected company | Any visible, currently non-void canonical claim in the assigned company | Currently non-void canonical claim whose recorded creator is the operator |

A user without Finance report access receives no insight result. Every request
uses `/api/companies/:company/...`; the server rechecks the authenticated
identity, active company or workspace membership, selected company, and current
module grants. A client-supplied company ID is not authority. There is no
cross-company or workspace-consolidated expense report in this release.

Changing the selected company, identity, role, grants, online state, or applied
filters invalidates the loaded report. In-flight responses are discarded when
their context is stale, and the PDF path checks the same context before and
after loading its font so a company switch cannot save the previous company's
report under the new context.

Linked-record labels in report detail follow the viewer's existing
permissions: stock items are visible, stock movements require stock-history
access, and purchase orders or goods receipts require cost access. The report
does not use a PDF to bypass inventory or procurement permissions.

## Historical and as-of behavior

The analytics endpoint runs its component queries in one PostgreSQL
`REPEATABLE READ` transaction. Calendar dates use the Kuala Lumpur business
date and both range endpoints are inclusive.

For canonical expenses:

- the expense date determines whether a claim belongs to the accrual cohort;
- payment and reversal events through `to` determine paid and outstanding
  balances as of that date;
- payment-source filters consider a source only when its net amount through
  `to` is positive;
- a void recorded after `to` does not remove the claim from that historical
  view, while a void effective on or before `to` does. A claim retained only
  for this historical reason is marked as unavailable for a current claim PDF;
  and
- cash movement is selected independently by each payment event's occurrence
  date, so historical cash remains visible even if the expense is voided later.

The as-of reconstruction applies to payments, reversals, derived settlement
status, overdue status, and the effective void date. It is not a full
bitemporal replay of every later edit to description, category, amount, payee,
or due date. The current canonical fields and the immutable lifecycle and
payment events remain the audit authority when reconstructing those changes.

The individual claim PDF is a current audit pack rather than an extract frozen
at the aggregate report's `to` date. It contains the current claim projection
and complete payment and lifecycle event history. Its endpoint excludes a
claim that is void today even when that claim correctly remains in an older
as-of aggregate.

When no dates are supplied directly to the API, it uses the current Kuala
Lumpur business date and a start date 365 days earlier. Explicit ranges must be
valid calendar dates, start on or before the end, and span no more than 3,653
days.

## Drafts

Drafts remain visible so teams can see work in preparation. They contribute to
the draft count and draft amount in period, category, claimant, bounded detail,
and PDF draft annotations. They contribute zero to recorded, paid,
outstanding, overdue, ageing, receipt coverage, and cash totals. A draft cannot
be mistaken for a payable or a settled expense.

The aggregate PDF's primary **Expenses** count is the posted count. When drafts
exist, a separate **DRAFTS / NOT POSTED** banner states their count, value, and
financial exclusions.

## Legacy records and claimant attribution

Company-scoped analytics include valid, non-void legacy transactions whose
type is exactly `Expense` or `Payment Voucher`. Their stored date must be a
valid calendar date. Amount is the legacy transaction total converted to sen.
A stored draft remains a draft. Other known open status spellings are treated
as unpaid; otherwise a valid `paidAmountSen` is capped at the transaction
amount, or the record is treated as fully paid. A payment dated after the
report end remains unpaid in that historical view. Payment source is preserved
when recognized, inferred from the legacy payment-method text where possible,
or reported as legacy/unspecified.

Legacy rows are labeled **Imported / unattributed**, have no typed linked-record
projection, and cannot produce an individual claim PDF because they do not have
the canonical immutable claim/payment/lifecycle model. They remain in company
aggregates and bounded aggregate detail. They are omitted from operator
self-scope rather than being assigned to a person without evidence.

There is one deliberate attribution limitation for imported canonical
expenses. Records with no `created_by`, or created before the request-digest
lineage was introduced, are also labeled **Imported / unattributed** even when
an importer identity is present. The importer is not evidence of the original
claimant. This release does not infer a claimant from payee text, payment actor,
or migration operator. Correcting that attribution requires separately
reviewed source evidence and a controlled data process.

## Bounded detail and failure limits

The server computes summary totals and distributions across every matched row,
up to 50,000 combined canonical and legacy expense records. It returns at most
2,000 ordered claim-detail rows. The boundary behavior is intentional:

- at 2,000 matched rows, the aggregate PDF can include complete line detail;
- above 2,000, `claimsLimited` is set while the full aggregate totals remain
  authoritative; and
- the browser supplies no partial detail rows to the PDF. The PDF instead says
  **DETAIL ROWS OMITTED**, omits its line-derived status table, and instructs
  the user to narrow the dates. The first 2,000 rows are never presented as if
  they were the complete population.

More than 50,000 matched expense rows fails closed with
`expense_insights_too_large`. More than 100 petty-cash funds opened by the
report end date in the selected company fails closed with
`expense_petty_cash_funds_too_large`. Totals outside the exact safe-integer sen
range also fail closed. These are report controls, not deletion or truncation
of source records.

## PDF behavior

The aggregate report is a selectable, paginated A4 portrait PDF. It identifies
the workspace, selected company, company registration when present, applied
range, generating user, generated time in MYT, and role scope. It includes the
posted metrics, draft notice, status summary when complete detail is available,
category and payment-source distributions, period movement, ageing and people,
oldest outstanding claims, role-appropriate petty-cash information, detail or
the bounded-detail notice, page numbers, and an audit control note.

Individual claim PDFs are available only for currently non-void canonical
claims. They contain claim details, the evidence-present indicator,
permission-filtered linked records, immutable payment and reversal history,
and lifecycle history with actor, reason, version, before state, and after
state. They do not embed receipt URLs, private storage paths, available
petty-cash balances, or hidden linked records. Source records and supporting
documents remain the audit authority.

Both download paths embed the bundled Droid Sans fallback font for
multilingual text. The font is loaded only when a PDF is requested. Filenames
are deterministic slugs:

- `<company>-expense-report-<from>-to-<to>.pdf`
- `<company>-expense-claim-<claim-reference>.pdf`

## Rollout and validation essentials

Migration `0053_expense_reporting_indexes.sql` adds tenant/date indexes for
canonical claimant scans, legacy expense and paid-date scans, payment events,
and petty-cash occurrence scans. Apply it through the normal tracked migration
runner before enabling the new UI, verify the migration record and index
presence, and verify that a second migration run is a no-op. The migration does
not import, rewrite, or reattribute expense data.

Deploy the API and web artifacts from the same accepted source. Rebuild the web
artifact so the new analytics view and bundled 5.4 MB font are present, then
verify that the offline build still completes. Use the normal pre-release
database and uploads backup, off-host checksum copy, and isolated restore
rehearsal. Record the exact commit, image IDs, migration state, backup receipt,
and browser acceptance in the environment's deployment receipt. The new
indexes are additive; an application rollback can leave them in place. Do not
restore an older database after live writes without reconciling those writes.

Release acceptance should cover:

1. super-admin, workspace-owner, manager, operator, Finance-revoked, disabled,
   and non-member access against at least two companies;
2. an operator's own-claim boundary, absence of legacy rows and fund balances,
   and denial of another claimant's individual report;
3. selected-company switching while a report or font load is in flight;
4. exact-sen reconciliation of recorded, paid, outstanding, cash out,
   reversals, due-on-end-date, later payment, and later void scenarios;
5. drafts remaining visible but excluded from every posted financial measure;
6. legacy paid, open, future-paid, invalid-date, voided, and unattributed
   examples without an individual claim action;
7. 2,000- and 2,001-row PDF behavior, the 50,000-row and 100-fund failure
   boundaries, and safe-integer overflow handling; and
8. paginated aggregate and claim PDFs with multilingual names, private receipt
   references absent, role-filtered links, lifecycle events, payments, and
   reversals.

Targeted source validation on 24 October 2026 passed 53 tests:

```text
node --test tests/expense-report.test.mjs tests/expense-analytics-ui.test.mjs tests/petty-cash-ui.test.mjs
# 27 passed

cd server
node --test test/expense-analytics.test.js test/expense-lifecycle.test.js
# 26 passed
```

Before promotion, also require the full frontend/domain suite, full server
suite, production web build, PostgreSQL 16 migration rehearsal, authenticated
API checks, and browser/PDF acceptance at the exact candidate commit. Source
tests alone do not prove deployed authorization, database plans, font delivery,
or tenant isolation.
