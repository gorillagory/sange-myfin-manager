-- One active company assignment per non-global application identity matches UI.
CREATE UNIQUE INDEX membership_one_company_idx ON myfin.memberships(identity_id);
ALTER TABLE myfin.companies ADD COLUMN archived_at timestamptz;
CREATE UNIQUE INDEX auth_credential_idx ON myfin.auth_account("providerId","accountId");
-- Core typed values must agree with the compatible JSON document representation.
ALTER TABLE myfin.products ADD CONSTRAINT product_stock_matches CHECK((data->>'stock')::numeric=stock);
ALTER TABLE myfin.transactions ADD CONSTRAINT transaction_total_matches CHECK((data->>'total')::numeric=total);
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_amount_matches CHECK((data->>'amount')::numeric=amount);
