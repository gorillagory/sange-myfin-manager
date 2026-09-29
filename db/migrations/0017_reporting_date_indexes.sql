-- Reports filter by tenant and business date before returning rows to the API.
-- Keep the raw JSON date indexes because older receipts use date-only or ISO
-- timestamps while newer receipts also carry an explicit businessDate.
CREATE INDEX transactions_report_business_date_idx
  ON myfin.transactions(company_id,(data->>'businessDate'));
CREATE INDEX transactions_report_issued_at_idx
  ON myfin.transactions(company_id,issued_at);
CREATE INDEX transactions_report_payload_date_idx
  ON myfin.transactions(company_id,(left(data->>'date',10)));
CREATE INDEX transactions_report_unusual_date_idx
  ON myfin.transactions(company_id)
  WHERE issued_at IS NULL AND (data->>'date' IS NULL
    OR left(data->>'date',10) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
CREATE INDEX expenses_report_payload_date_idx
  ON myfin.expenses(company_id,(left(data->>'date',10)))
  WHERE voided_at IS NULL;
CREATE INDEX expenses_report_unusual_date_idx
  ON myfin.expenses(company_id)
  WHERE voided_at IS NULL AND (data->>'date' IS NULL
    OR left(data->>'date',10) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
CREATE INDEX document_payments_report_paid_at_idx
  ON myfin.document_payments(company_id,paid_at);
