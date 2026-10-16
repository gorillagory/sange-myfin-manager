-- Durable, tenant-scoped receipt email delivery.  The application stores the
-- exact rendered message before enqueueing so later product, customer or
-- template edits cannot rewrite a receipt that was already requested.

CREATE TABLE myfin.receipt_email_deliveries (
  company_id text NOT NULL,
  id text NOT NULL CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  transaction_id text NOT NULL,
  idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  requested_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  recipient text NOT NULL CHECK(length(recipient) BETWEEN 3 AND 254 AND recipient=btrim(recipient)),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 500),
  text_body text NOT NULL CHECK(length(text_body) BETWEEN 1 AND 100000),
  html_body text NOT NULL CHECK(length(html_body) BETWEEN 1 AND 200000),
  state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','running','retry_wait','sent','failed','delivery_unknown')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 8),
  max_attempts integer NOT NULL DEFAULT 8 CHECK(max_attempts=8),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  retry_budget_expires_at timestamptz NOT NULL DEFAULT (now()+interval '72 hours'),
  lease_owner text CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  last_error_code text NOT NULL DEFAULT '' CHECK(last_error_code IN (
    '','smtp_connect_unavailable','smtp_temporary_rejection','smtp_authentication_failed',
    'recipient_rejected','message_rejected','retry_budget_exhausted','delivery_outcome_unknown'
  )),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,idempotency_key),
  FOREIGN KEY(company_id,transaction_id)
    REFERENCES myfin.transactions(company_id,id) ON DELETE RESTRICT,
  CHECK(retry_budget_expires_at>created_at),
  CHECK((state='running')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((state='sent')=(accepted_at IS NOT NULL)),
  CHECK(state='sent' OR accepted_at IS NULL)
);

CREATE INDEX receipt_email_delivery_transaction_idx
  ON myfin.receipt_email_deliveries(company_id,transaction_id,created_at DESC,id DESC);
CREATE INDEX receipt_email_delivery_due_idx
  ON myfin.receipt_email_deliveries(next_attempt_at,company_id,id)
  WHERE state IN ('queued','retry_wait','running');

CREATE TABLE myfin.receipt_email_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  delivery_id text NOT NULL,
  actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK(event_type IN (
    'queued','attempt_started','retry_scheduled','sent','failed','delivery_unknown'
  )),
  error_code text NOT NULL DEFAULT '' CHECK(error_code IN (
    '','smtp_connect_unavailable','smtp_temporary_rejection','smtp_authentication_failed',
    'recipient_rejected','message_rejected','retry_budget_exhausted','delivery_outcome_unknown'
  )),
  attempt_count integer NOT NULL CHECK(attempt_count BETWEEN 0 AND 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,delivery_id)
    REFERENCES myfin.receipt_email_deliveries(company_id,id) ON DELETE RESTRICT
);

CREATE INDEX receipt_email_events_delivery_idx
  ON myfin.receipt_email_events(company_id,delivery_id,created_at,id);

CREATE FUNCTION myfin.protect_receipt_email_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF TG_OP='UPDATE' AND
     (to_jsonb(NEW)-ARRAY['state','attempt_count','next_attempt_at','lease_owner','lease_expires_at',
       'last_error_code','accepted_at','updated_at'])=
     (to_jsonb(OLD)-ARRAY['state','attempt_count','next_attempt_at','lease_owner','lease_expires_at',
       'last_error_code','accepted_at','updated_at']) AND
     ((OLD.state IN ('queued','retry_wait') AND NEW.state='running' AND
        NEW.attempt_count=OLD.attempt_count+1 AND NEW.lease_owner IS NOT NULL AND
        NEW.lease_expires_at IS NOT NULL AND NEW.last_error_code='') OR
      (OLD.state IN ('queued','retry_wait') AND NEW.state='failed' AND
        NEW.attempt_count=OLD.attempt_count AND NEW.lease_owner IS NULL AND
        NEW.lease_expires_at IS NULL AND NEW.last_error_code='retry_budget_exhausted' AND
        (NEW.attempt_count>=NEW.max_attempts OR NEW.retry_budget_expires_at<=NEW.updated_at)) OR
      (OLD.state='running' AND NEW.state IN ('sent','retry_wait','failed','delivery_unknown') AND
        NEW.attempt_count=OLD.attempt_count AND NEW.lease_owner IS NULL AND
        NEW.lease_expires_at IS NULL))
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'receipt_email_delivery_immutable' USING ERRCODE='23514';
END $$;

CREATE TRIGGER protect_receipt_email_delivery
  BEFORE UPDATE OR DELETE ON myfin.receipt_email_deliveries
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_receipt_email_delivery();

CREATE FUNCTION myfin.protect_receipt_email_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'receipt_email_event_immutable' USING ERRCODE='23514';
END $$;

CREATE TRIGGER protect_receipt_email_event
  BEFORE UPDATE OR DELETE ON myfin.receipt_email_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_receipt_email_event();

REVOKE ALL ON myfin.receipt_email_deliveries,myfin.receipt_email_events FROM PUBLIC;

COMMENT ON TABLE myfin.receipt_email_deliveries IS
  'Durable rendered receipt messages and bounded SMTP delivery state. SMTP credentials never enter PostgreSQL.';
COMMENT ON COLUMN myfin.receipt_email_deliveries.recipient IS
  'Operational receipt destination supplied by staff; never grants customer identity or marketing consent.';
COMMENT ON COLUMN myfin.receipt_email_deliveries.state IS
  'delivery_unknown is intentionally not retried automatically because SMTP may have accepted the message before a connection or worker failure.';
