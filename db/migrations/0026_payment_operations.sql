-- Provider payment evidence is deliberately separate from MyFin cash and sales.
-- An approved importer may append normalized transaction facts in a later phase;
-- the application runtime receives read access only. Raw payloads and credentials
-- are never stored in this table.

CREATE TABLE myfin.integration_payment_transactions (
  company_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  connection_id text NOT NULL,
  external_transaction_key text NOT NULL CHECK (length(external_transaction_key) BETWEEN 1 AND 256),
  external_order_id text CHECK (external_order_id IS NULL OR length(external_order_id) BETWEEN 1 AND 256),
  transaction_type text NOT NULL CHECK (transaction_type IN (
    'authorization','capture','refund','settlement','chargeback','adjustment'
  )),
  payment_method text NOT NULL CHECK (payment_method IN (
    'cash','card','qr','bank_transfer','e_wallet','provider_balance','other','unknown'
  )),
  provider_method_code text NOT NULL DEFAULT '' CHECK (
    length(provider_method_code) <= 80 AND provider_method_code ~ '^[A-Za-z0-9_.:-]*$'
  ),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_sen bigint NOT NULL CHECK (amount_sen BETWEEN -9000000000000000 AND 9000000000000000),
  provider_status text NOT NULL DEFAULT '' CHECK (
    length(provider_status) <= 80 AND provider_status ~ '^[A-Za-z0-9_.:-]*$'
  ),
  source_event_key text,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  accounting_effect text NOT NULL DEFAULT 'none' CHECK (accounting_effect='none'),
  occurred_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,id),
  UNIQUE (company_id,connection_id,external_transaction_key),
  FOREIGN KEY (company_id,connection_id)
    REFERENCES myfin.integration_connections(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,connection_id,source_event_key)
    REFERENCES myfin.integration_events(company_id,connection_id,provider_event_key) ON DELETE RESTRICT
);

CREATE INDEX integration_payment_transactions_ops_idx
  ON myfin.integration_payment_transactions(company_id,occurred_at DESC,imported_at DESC,id);
CREATE INDEX integration_payment_transactions_connection_idx
  ON myfin.integration_payment_transactions(company_id,connection_id,provider_status,occurred_at DESC,id);

CREATE TRIGGER immutable_integration_payment_transactions
  BEFORE UPDATE OR DELETE ON myfin.integration_payment_transactions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_integration_evidence();
CREATE TRIGGER no_truncate_integration_payment_transactions
  BEFORE TRUNCATE ON myfin.integration_payment_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_integration_evidence();

REVOKE ALL ON myfin.integration_payment_transactions FROM PUBLIC;

COMMENT ON TABLE myfin.integration_payment_transactions IS
  'Immutable, tenant-scoped normalized provider payment evidence. No raw payload, PII or credential material.';
COMMENT ON COLUMN myfin.integration_payment_transactions.accounting_effect IS
  'Provider evidence is informational until a separately reviewed accounting posting workflow exists.';
