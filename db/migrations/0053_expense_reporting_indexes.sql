-- Expense and claim reporting scans by tenant, immutable claimant and effective
-- business date. Cash and petty-cash charts scan their append-only occurrence
-- dates independently from the expense accrual date.

CREATE INDEX expenses_claimant_business_date_idx
  ON myfin.expenses(company_id,created_by,myfin.valid_expense_date(data->>'date'),id);

CREATE INDEX expenses_business_date_idx
  ON myfin.expenses(company_id,myfin.valid_expense_date(data->>'date'),id);

CREATE INDEX transactions_legacy_expense_business_date_idx
  ON myfin.transactions(company_id,(left(data->>'date',10)),id)
  WHERE document_state='legacy'
    AND data->>'type' IN ('Expense','Payment Voucher')
    AND coalesce(data->>'status','')<>'Voided';

CREATE INDEX transactions_legacy_expense_paid_date_idx
  ON myfin.transactions(company_id,
    (coalesce(myfin.valid_expense_date(left(data->>'paidOn',10)),
      myfin.valid_expense_date(left(data->>'date',10)))),id)
  WHERE document_state='legacy'
    AND data->>'type' IN ('Expense','Payment Voucher')
    AND coalesce(data->>'status','')<>'Voided';

CREATE INDEX expense_payment_events_company_date_idx
  ON myfin.expense_payment_events(company_id,occurred_on,id);

CREATE INDEX petty_cash_entries_company_date_idx
  ON myfin.petty_cash_entries(company_id,occurred_at,id);
