# Expense, petty cash and module access

## Scope

This document describes the implemented application and database contract. It does not by itself record that an environment has been migrated or accepted. The core implementation is in `0043_petty_cash.sql`, `0044_dynamic_module_access.sql`, the expense and petty-cash API, the Expenses UI, and the shared permission model.

## Implemented financial behavior

### Expense lifecycle and settlement

Expenses use four stored states: `draft`, `pending_payment`, `partially_paid`, and `paid`. `overdue` is a displayed state derived when a pending or partially paid credit expense is past its due date. `voided` is also an effective state: the row is retained and marked with actor, time, and reason instead of being deleted.

A newly recorded paid expense is first inserted without a cash effect, then settled through the payment-event workflow in the same API transaction. Partial and paid states are derived from the net value of immutable payment and reversal events; users cannot set `partially_paid` directly or turn an existing unpaid expense into `paid` by editing it. The paid date is present only when the full amount is settled. An expense amount cannot be reduced below payments already recorded.

Settlements support app user, named non-user, petty cash, bank, card, and other sources. Credit expenses are created unpaid and later settled through one or more payment events. Each write includes an expected expense version and idempotency key, so stale edits fail and an exact retry returns the committed result without duplicating money movement. Reusing a key with different data is rejected.

A payment reversal appends a linked event for the full original payment; it never edits or deletes the original. The expense paid amount, outstanding amount, status, and final settlement date are recalculated from active events. A paid expense must have all payments reversed before it can be voided. Managers with Finance access can pay, reverse, edit, and void; Workspace owners and SuperAdmins retain those capabilities across their scope. An Operator with Finance access can read and create expenses; an Operator void additionally requires a Manager's one-action six-digit approval. Mutations require live, current server data.

Expense lifecycle events retain creation, update, import, payment, reversal, settlement, and void history. Stock item, stock movement, purchase order, and goods receipt links provide traceability to operational evidence. CSV import deliberately rejects partially paid rows because a flat row cannot reconstruct payment history; import them as pending and record their payments in the application.

### Petty fund lifecycle

A company may have multiple funds, with at most one open default fund. Opening a fund creates its opening-balance ledger entry atomically. The first open fund becomes the default when none exists. A fund has a name, MYR currency code, low-balance threshold, open/closed state, version, creator, and open/close timestamps.

An open fund accepts replenishment, adjustment in, adjustment out, cash-count reconciliation, reversal, and close entries. Reconciliation records the physical count and posts the variance needed to make the ledger balance equal that count; it does not hide the difference. The database locks the fund, derives the balance from signed entries, rejects a negative result, and verifies every recorded balance-after value. A fund can close only at zero. There is no manual reopen action; reversing an expense payment from a closed fund automatically reopens that fund as non-default and appends an audited zero-value reopen entry before restoring the cash.

Petty-cash expense settlement creates both the expense payment and matching fund disbursement in one transaction. Insufficient cash rejects the entire operation. Reversing that payment creates a linked expense-payment reversal and restores the same fund with a linked ledger reversal in the same transaction. Expense disbursements cannot be reversed from the fund screen; the payment workflow is the accounting authority.

Ledger and payment rows are append-only at the database boundary. Opening, close, reversal, and expense-disbursement rows are not generally reversible from the fund screen. Ordinary manual movements may be reversed once while the fund is open. Actor, event time, effective date, reason, reference, links, and idempotency evidence are retained.

### Accounting and audit meaning

Money is validated to two decimal places and stored as integer sen for payment and ledger controls. Recorded expense total, paid amount, and outstanding amount are distinct: creating a draft or payable records the obligation without claiming cash moved; a payment event records settlement. A petty-cash count posts an explicit variance. These records form a controlled operational subledger, not a full double-entry general ledger or a bank/card payment instruction.

Migration `0043` seeds one immutable payment event for each pre-existing paid expense. A legacy petty-cash label cannot be assigned safely to a newly introduced fund, so it is preserved as an `other` source named `Legacy petty cash (unallocated)` and does not alter a fund balance.

Corrections use reversals and voids, with reasons, instead of destructive edits. The generated PDF is a presentation of authorized records; source expense rows, attached evidence, lifecycle events, payment events, and petty-cash entries remain authoritative.

## Finance PDF controls

The **Finance PDF** action requires `financialReports` and is hosted on the Expenses page. A Manager therefore needs Finance to enter the page; Analytics also satisfies the report capability but does not by itself open the Expenses route. Operators cannot generate the report. Workspace owners and SuperAdmins retain it. The browser builds the PDF from records already returned within the active company scope and applies the current date, status, payment-source, and search filters.

The PDF contains company/workspace identity, generator and Malaysia-time timestamp, recorded/paid/outstanding totals, evidence count, status/category/payment-source summaries, expense detail, page numbers, and a control note. When petty cash is available it includes one selected fund's filtered movement detail and reconciliation totals. The exporter loads the complete selected ledger in pages of 500, stops above 50,000 entries, and warns when only a partial ledger is available. An offline/cached export may omit petty-cash detail because that ledger requires a live authorized read.

The PDF does not embed receipt files, digitally sign the report, replace source evidence, determine tax deductibility, or file a return. The design treats evidence retention as an operational requirement in the context of HASiL's [digital-business guidance](https://www.hasil.gov.my/syarikat/perniagaan-digital/) and [business tax material](https://www.hasil.gov.my/media/daolqeph/slaid-business-tax.pdf); accounting and tax treatment still require the company's adviser and current official rules.

## Dynamic per-company module access

Module grants are company-scoped allow-lists layered under roles. The seven modules are Workspace, Inventory, Finance, Analytics, Administration, Settings, and User administration (`access`). The server loads the grant for the company on every authorization path; switching companies changes the effective list. Navigation and hydration follow the same list, but API authorization remains the security boundary.

| Role | Module ceiling | Expense effect |
| --- | --- | --- |
| SuperAdmin | All modules; cannot be narrowed by company grants | Global owner-level capabilities |
| Workspace owner | All modules; cannot be narrowed by company grants | Owner capabilities in every company in the workspace |
| Manager | All seven modules | Finance enables expense/petty-cash management; Finance or Analytics enables the report |
| Operator | Workspace, Inventory, Finance, Administration, Settings | Finance enables expense read/create; role rules still deny payment, petty-cash management, editing, and reports |

A missing grant row preserves the role's default module ceiling for compatibility. An explicit empty array leaves only profile access. Duplicate or unknown modules and modules above the target role ceiling are rejected. Saving role, company assignment, or module changes revokes the target's sessions within the manager's company or workspace owner's workspace. An exclusive identity also has its password session revoked; only a SuperAdmin can change or suspend a shared identity across workspaces. Managers also need User administration access to manage Operators and still cannot appoint Managers or grant modules they do not hold in that company.

This follows the role-plus-permission structure described in the [NIST RBAC FAQ](https://csrc.nist.gov/Projects/Role-Based-Access-Control/faqs), while adding a company-scoped narrowing layer. The reference is a design basis, not a claim of NIST certification.

## Operational setup and rollout

Use this order exactly: **`0043_petty_cash.sql` → `0044_dynamic_module_access.sql` → environment runtime grants**. Do not deploy the new API between those steps and do not save per-company module assignments before `0044` exists.

1. Put financial writers into a maintenance window. Take a fresh matched database/uploads backup, record checksums off-host, and confirm the prior application image identifiers and a successful isolated restore rehearsal.
2. Build from the exact reviewed source. Run the normal migration command with the environment's migrator/owner credentials. The migration runner sorts filenames and applies all pending files plus migration-ledger rows in one transaction, so `0043` precedes `0044`.
3. Verify both exact versions in `myfin.schema_migrations`. Confirm that `petty_cash_funds`, `petty_cash_entries`, `expense_payment_events`, and `membership_module_grants` exist and that no unexpected migration is pending.
4. Apply the matching post-migration ACL file as the provisioning administrator: `db/grant-development-runtime.sql` for `myfin_dev` or `db/grant-production-runtime.sql` for `myfin_prod`. This separate step grants the runtime role only the required access to the new tables. The standard `migrate.sh` and `production-migrate.sh` perform the migration and matching grant script in that sequence.
5. Deploy the matching API and web artifacts together. Run the normal health/smoke checks, then verify an authorized company can list expenses while a user whose grant omits Finance receives access denied from the API.
6. Exercise one controlled fund end to end: open, replenish, adjust, count, record a pending expense, settle it partially and fully, reverse the payment, and close only after reaching zero. Confirm duplicate retries do not duplicate entries and that the PDF totals agree with the source events.
7. Configure per-company module lists in People & access. Existing Manager and Operator memberships have role defaults until an administrator saves an explicit list. Test each affected account after its sessions are revoked, including a company switch for multi-company users.

Useful post-migration checks:

```sql
SELECT version, applied_at
FROM myfin.schema_migrations
WHERE version IN ('0043_petty_cash.sql', '0044_dynamic_module_access.sql')
ORDER BY version;

SELECT table_name, privilege_type, grantee
FROM information_schema.role_table_grants
WHERE table_schema = 'myfin'
  AND table_name IN ('petty_cash_funds', 'petty_cash_entries',
                     'expense_payment_events', 'membership_module_grants')
ORDER BY table_name, grantee, privilege_type;
```

## Recovery and rollback

If the migration command fails before commit, its transaction rolls back the whole pending batch. Keep the application on the prior version, correct the cause, and rerun. If both migrations commit but the separate ACL step fails, do not deploy the new application; correct and reapply the environment-specific grant file.

After any committed financial write, preserve the application, database, and audit logs before intervention. Correct a mistaken payment or manual fund movement with the supported linked reversal; never update or delete evidence rows. A grant mistake is recoverable by saving the intended module list and having the user sign in again.

There is no supported down migration. For a code-only problem, prefer a forward fix because `0043` changes the stored status vocabulary and payment model. If full rollback is required, stop all writers and restore the matched pre-`0043` database/uploads backup together with the prior application images; reconcile every transaction accepted after that backup before reopening. Do not combine a pre-release application with a post-`0043` database without an explicit compatibility review.

## Intentional constraints

- Petty cash is MYR-only, uses two-decimal amounts, and allows one open default fund per company. Closed funds reopen only as an audited, non-default correction when a linked expense payment is reversed.
- Fund management and expense settlement are Manager/owner Finance functions. Operator expense creation does not grant access to the cash fund.
- A payment reversal reverses the whole selected payment. Split corrections require reversing it and recording the correct replacement payments.
- Legacy paid expenses retain migrated evidence, but legacy petty-cash labels are not assigned to a modern fund automatically.
- PDFs reconcile one selected fund, cap ledger export at 50,000 entries, and remain unsigned point-in-time summaries. Receipt attachments stay separate.
- CSV import is limited to 500 rows and cannot import a partially paid history.
- No financial mutation is supported from cached/offline state. Bank/card labels record an observed source; they do not contact a payment processor.
- Module grants narrow role capabilities only. They do not create new permissions, override company/workspace scope, or reduce Workspace owner and SuperAdmin access.
