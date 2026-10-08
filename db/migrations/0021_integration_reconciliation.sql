-- Provider-neutral integration metadata and append-only reconciliation evidence.
-- This migration deliberately creates no webhook, network, order, stock or
-- accounting side effects. Runtime credentials live outside PostgreSQL; only
-- references to an approved secret store may be recorded here.

CREATE TABLE myfin.integration_connections (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
  integration_kind text NOT NULL CHECK (integration_kind IN ('commerce_channel','payment_provider')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  identity_status text NOT NULL DEFAULT 'candidate_awaiting_confirmation'
    CHECK (identity_status IN ('candidate_awaiting_confirmation','confirmed','rejected')),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','pending','active')),
  country_code text NOT NULL DEFAULT 'MY' CHECK (country_code ~ '^[A-Z]{2}$'),
  currency_code text NOT NULL DEFAULT 'MYR' CHECK (currency_code ~ '^[A-Z]{3}$'),
  external_account_id text CHECK (external_account_id IS NULL OR length(external_account_id) BETWEEN 1 AND 256),
  credential_ref text CHECK (
    credential_ref IS NULL OR
    credential_ref ~ '^(secretref|vault|file|aws-secretsmanager|gcp-secret-manager|azure-keyvault)://[^[:space:]]{1,450}$'
  ),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities)='object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,id),
  UNIQUE (company_id,provider_key,integration_kind),
  CHECK (status <> 'active' OR (
    identity_status='confirmed' AND external_account_id IS NOT NULL AND credential_ref IS NOT NULL
  ))
);
CREATE INDEX integration_connections_company_status_idx
  ON myfin.integration_connections(company_id,status,provider_key);

CREATE TABLE myfin.integration_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  connection_id text NOT NULL,
  provider_event_key text NOT NULL CHECK (length(provider_event_key) BETWEEN 1 AND 256),
  event_direction text NOT NULL CHECK (event_direction IN ('inbound','outbound','poll')),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  normalized_status text NOT NULL DEFAULT '' CHECK (length(normalized_status) <= 80),
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  PRIMARY KEY (company_id,id),
  UNIQUE (company_id,connection_id,provider_event_key),
  FOREIGN KEY (company_id,connection_id)
    REFERENCES myfin.integration_connections(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX integration_events_connection_time_idx
  ON myfin.integration_events(company_id,connection_id,received_at DESC,id);

CREATE TABLE myfin.integration_financial_entries (
  company_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  connection_id text NOT NULL,
  external_financial_key text NOT NULL CHECK (length(external_financial_key) BETWEEN 1 AND 256),
  external_order_id text CHECK (external_order_id IS NULL OR length(external_order_id) BETWEEN 1 AND 256),
  entry_type text NOT NULL CHECK (entry_type IN (
    'order_total','products_total','delivery_fee','merchant_subsidy','platform_subsidy',
    'tax','customer_paid','platform_expense','platform_commission','service_fee',
    'service_fee_tax_inclusive','merchant_receivable','merchant_actual_receivable',
    'rider_commission','refund','adjustment'
  )),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_sen bigint NOT NULL CHECK (amount_sen BETWEEN -9000000000000000 AND 9000000000000000),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  source_event_key text,
  accounting_effect text NOT NULL DEFAULT 'none' CHECK (accounting_effect='none'),
  occurred_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  PRIMARY KEY (company_id,id),
  UNIQUE (company_id,connection_id,external_financial_key),
  FOREIGN KEY (company_id,connection_id)
    REFERENCES myfin.integration_connections(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,connection_id,source_event_key)
    REFERENCES myfin.integration_events(company_id,connection_id,provider_event_key) ON DELETE RESTRICT
);
CREATE INDEX integration_financial_order_idx
  ON myfin.integration_financial_entries(company_id,connection_id,external_order_id,recorded_at DESC,id);

CREATE TABLE myfin.integration_reconciliations (
  company_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  connection_id text NOT NULL,
  reconciliation_key text NOT NULL CHECK (length(reconciliation_key) BETWEEN 1 AND 256),
  scope_type text NOT NULL CHECK (scope_type IN ('external_order','settlement','time_window')),
  external_reference text NOT NULL CHECK (length(external_reference) BETWEEN 1 AND 256),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  expected_amount_sen bigint CHECK (expected_amount_sen BETWEEN -9000000000000000 AND 9000000000000000),
  observed_amount_sen bigint CHECK (observed_amount_sen BETWEEN -9000000000000000 AND 9000000000000000),
  difference_amount_sen bigint GENERATED ALWAYS AS (observed_amount_sen-expected_amount_sen) STORED,
  status text NOT NULL CHECK (status IN ('pending','matched','mismatch','unavailable')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  PRIMARY KEY (company_id,id),
  UNIQUE (company_id,connection_id,reconciliation_key),
  FOREIGN KEY (company_id,connection_id)
    REFERENCES myfin.integration_connections(company_id,id) ON DELETE RESTRICT,
  CHECK (
    (status IN ('matched','mismatch') AND expected_amount_sen IS NOT NULL AND observed_amount_sen IS NOT NULL) OR
    (status IN ('pending','unavailable') AND expected_amount_sen IS NULL AND observed_amount_sen IS NULL)
  ),
  CHECK (status <> 'matched' OR difference_amount_sen=0),
  CHECK (status <> 'mismatch' OR difference_amount_sen<>0)
);
CREATE INDEX integration_reconciliations_summary_idx
  ON myfin.integration_reconciliations(company_id,connection_id,status,checked_at DESC,id);

CREATE FUNCTION myfin.protect_integration_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'integration_evidence_immutable' USING ERRCODE='23514';
END $$;

CREATE TRIGGER immutable_integration_events
  BEFORE UPDATE OR DELETE ON myfin.integration_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_integration_evidence();
CREATE TRIGGER no_truncate_integration_events
  BEFORE TRUNCATE ON myfin.integration_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_integration_evidence();
CREATE TRIGGER immutable_integration_financial_entries
  BEFORE UPDATE OR DELETE ON myfin.integration_financial_entries
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_integration_evidence();
CREATE TRIGGER no_truncate_integration_financial_entries
  BEFORE TRUNCATE ON myfin.integration_financial_entries
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_integration_evidence();
CREATE TRIGGER immutable_integration_reconciliations
  BEFORE UPDATE OR DELETE ON myfin.integration_reconciliations
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_integration_evidence();
CREATE TRIGGER no_truncate_integration_reconciliations
  BEFORE TRUNCATE ON myfin.integration_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_integration_evidence();

REVOKE ALL ON myfin.integration_connections FROM PUBLIC;
REVOKE ALL ON myfin.integration_events FROM PUBLIC;
REVOKE ALL ON myfin.integration_financial_entries FROM PUBLIC;
REVOKE ALL ON myfin.integration_reconciliations FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_integration_evidence() FROM PUBLIC;

COMMENT ON COLUMN myfin.integration_connections.credential_ref IS
  'Reference to an externally managed secret only. Credential material must never be stored in this database.';
COMMENT ON TABLE myfin.integration_events IS
  'Immutable, tenant-scoped provider event evidence. metadata must be sanitized and credential-free.';
COMMENT ON COLUMN myfin.integration_financial_entries.accounting_effect IS
  'Foundation records provider facts only; it cannot recognize cash or post accounting entries.';
