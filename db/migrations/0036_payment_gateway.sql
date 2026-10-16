-- Company-scoped hosted-payment foundation. Credential material stays in an
-- operator-mounted secret file; PostgreSQL stores only an opaque secretref key.
-- Online payment evidence is deliberately separate from POS sale posting and
-- customer_order_requests.payment_state.

CREATE TABLE myfin.payment_gateway_connections (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  provider_key text NOT NULL CHECK(provider_key='hitpay'),
  provider_environment text NOT NULL DEFAULT 'sandbox'
    CHECK(provider_environment IN ('sandbox','production')),
  status text NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','active')),
  secret_ref text CHECK(secret_ref IS NULL OR
    secret_ref ~ '^secretref://[A-Za-z0-9][A-Za-z0-9/_-]{0,239}$'),
  account_hint text NOT NULL DEFAULT '' CHECK(length(account_hint) <= 80),
  currency_code text NOT NULL DEFAULT 'MYR' CHECK(currency_code='MYR'),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,provider_key),
  CHECK(status<>'active' OR secret_ref IS NOT NULL)
);

CREATE TABLE myfin.online_payment_intents (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  order_id text NOT NULL,
  connection_id text NOT NULL,
  connection_version integer NOT NULL CHECK(connection_version > 0),
  provider_environment text NOT NULL CHECK(provider_environment IN ('sandbox','production')),
  secret_ref_snapshot text NOT NULL CHECK(
    secret_ref_snapshot ~ '^secretref://[A-Za-z0-9][A-Za-z0-9/_-]{0,239}$'),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  provider_reference text NOT NULL CHECK(length(provider_reference) BETWEEN 1 AND 128),
  amount_sen bigint NOT NULL CHECK(amount_sen BETWEEN 1 AND 9000000000000000),
  currency_code text NOT NULL CHECK(currency_code='MYR'),
  order_version integer NOT NULL CHECK(order_version > 0),
  order_status_snapshot text NOT NULL CHECK(order_status_snapshot IN ('accepted','preparing','ready')),
  public_code_snapshot text NOT NULL CHECK(public_code_snapshot ~ '^[A-Z0-9]{8}$'),
  hold_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,idempotency_key),
  UNIQUE(company_id,provider_reference),
  FOREIGN KEY(company_id,order_id)
    REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,connection_id)
    REFERENCES myfin.payment_gateway_connections(company_id,id) ON DELETE RESTRICT,
  CHECK(hold_until > created_at)
);
CREATE INDEX online_payment_intents_order_idx
  ON myfin.online_payment_intents(company_id,order_id,created_at DESC,id);

CREATE TABLE myfin.online_payment_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  intent_id text NOT NULL,
  event_no integer NOT NULL CHECK(event_no > 0),
  event_type text NOT NULL CHECK(event_type IN (
    'checkout_creation_started','checkout_created','checkout_creation_failed','checkout_creation_unknown',
    'webhook_rejected','payment_confirmed','payment_reconciliation_required'
  )),
  provider_event_key text CHECK(provider_event_key IS NULL OR length(provider_event_key) BETWEEN 1 AND 256),
  payload_digest text CHECK(payload_digest IS NULL OR payload_digest ~ '^[0-9a-f]{64}$'),
  provider_payment_request_id text CHECK(provider_payment_request_id IS NULL OR
    length(provider_payment_request_id) BETWEEN 1 AND 128),
  provider_payment_id text CHECK(provider_payment_id IS NULL OR length(provider_payment_id) BETWEEN 1 AND 128),
  provider_method_code text NOT NULL DEFAULT '' CHECK(
    length(provider_method_code) <= 80 AND provider_method_code ~ '^[A-Za-z0-9_.:-]*$'
  ),
  provider_status text NOT NULL DEFAULT '' CHECK(
    length(provider_status) <= 80 AND provider_status ~ '^[A-Za-z0-9_.:-]*$'
  ),
  checkout_url text CHECK(checkout_url IS NULL OR
    (length(checkout_url) <= 2048 AND
     checkout_url ~ '^https://securecheckout([.]sandbox)?[.]hit-pay[.]com/[^[:space:]]+$')),
  observed_amount_sen bigint CHECK(observed_amount_sen IS NULL OR
    observed_amount_sen BETWEEN 1 AND 9000000000000000),
  observed_currency_code text CHECK(observed_currency_code IS NULL OR observed_currency_code='MYR'),
  failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN (
    '','provider_request_rejected','provider_outcome_unknown','provider_response_invalid',
    'amount_mismatch','currency_mismatch','reference_mismatch','payment_request_mismatch',
    'payment_not_succeeded','order_not_payable'
  )),
  provider_occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,intent_id,event_no),
  UNIQUE(company_id,intent_id,provider_event_key),
  FOREIGN KEY(company_id,intent_id)
    REFERENCES myfin.online_payment_intents(company_id,id) ON DELETE RESTRICT,
  CHECK(
    (event_type='checkout_creation_started' AND provider_payment_request_id IS NULL AND
      checkout_url IS NULL AND failure_code='') OR
    (event_type='checkout_created' AND provider_payment_request_id IS NOT NULL AND
      checkout_url IS NOT NULL AND provider_status='pending' AND failure_code='') OR
    (event_type='checkout_creation_failed' AND provider_payment_request_id IS NULL AND
      checkout_url IS NULL AND failure_code='provider_request_rejected') OR
    (event_type='checkout_creation_unknown' AND provider_payment_request_id IS NULL AND
      checkout_url IS NULL AND failure_code='provider_outcome_unknown') OR
    (event_type='webhook_rejected' AND provider_event_key IS NOT NULL AND payload_digest IS NOT NULL AND
      failure_code NOT IN ('','provider_unavailable')) OR
    (event_type IN ('payment_confirmed','payment_reconciliation_required') AND
      provider_event_key IS NOT NULL AND payload_digest IS NOT NULL AND
      provider_payment_request_id IS NOT NULL AND provider_payment_id IS NOT NULL AND
      provider_method_code<>'' AND provider_status='completed' AND
      observed_amount_sen IS NOT NULL AND observed_currency_code='MYR' AND
      ((event_type='payment_confirmed' AND failure_code='') OR
       (event_type='payment_reconciliation_required' AND failure_code='order_not_payable')))
  )
);
CREATE INDEX online_payment_events_intent_idx
  ON myfin.online_payment_events(company_id,intent_id,event_no DESC);
CREATE UNIQUE INDEX online_payment_checkout_request_unique
  ON myfin.online_payment_events(company_id,provider_payment_request_id)
  WHERE event_type='checkout_created';
CREATE UNIQUE INDEX online_payment_checkout_once
  ON myfin.online_payment_events(company_id,intent_id) WHERE event_type='checkout_created';
CREATE UNIQUE INDEX online_payment_confirmed_once
  ON myfin.online_payment_events(company_id,intent_id)
  WHERE event_type IN ('payment_confirmed','payment_reconciliation_required');
CREATE UNIQUE INDEX online_payment_actual_request_unique
  ON myfin.online_payment_events(company_id,provider_payment_request_id)
  WHERE event_type IN ('payment_confirmed','payment_reconciliation_required');
CREATE UNIQUE INDEX online_payment_actual_payment_unique
  ON myfin.online_payment_events(company_id,provider_payment_id)
  WHERE event_type IN ('payment_confirmed','payment_reconciliation_required');

-- A confirmed provider payment is posted through the ordinary POS accounting
-- path by an authorised staff member. This immutable link makes that posting
-- exactly-once and keeps the provider evidence separate from the sale record.
CREATE TABLE myfin.online_payment_finalizations (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  intent_id text NOT NULL,
  order_id text NOT NULL,
  sale_id text NOT NULL,
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,intent_id),
  UNIQUE(company_id,order_id),
  UNIQUE(company_id,sale_id),
  UNIQUE(company_id,request_id),
  FOREIGN KEY(company_id,intent_id)
    REFERENCES myfin.online_payment_intents(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,order_id)
    REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,sale_id)
    REFERENCES myfin.transactions(company_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION myfin.protect_online_payment_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'online_payment_evidence_immutable' USING ERRCODE='23514';
END $$;

CREATE TRIGGER immutable_online_payment_intents
  BEFORE UPDATE OR DELETE ON myfin.online_payment_intents
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_online_payment_evidence();
CREATE TRIGGER no_truncate_online_payment_intents
  BEFORE TRUNCATE ON myfin.online_payment_intents
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_online_payment_evidence();
CREATE TRIGGER immutable_online_payment_events
  BEFORE UPDATE OR DELETE ON myfin.online_payment_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_online_payment_evidence();
CREATE TRIGGER no_truncate_online_payment_events
  BEFORE TRUNCATE ON myfin.online_payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_online_payment_evidence();
CREATE TRIGGER immutable_online_payment_finalizations
  BEFORE UPDATE OR DELETE ON myfin.online_payment_finalizations
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_online_payment_evidence();
CREATE TRIGGER no_truncate_online_payment_finalizations
  BEFORE TRUNCATE ON myfin.online_payment_finalizations
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_online_payment_evidence();

CREATE VIEW myfin.customer_order_online_payment_state
WITH (security_barrier=true) AS
SELECT i.company_id,i.order_id,i.id AS intent_id,i.connection_id,i.amount_sen,i.currency_code,i.hold_until,
  CASE
    WHEN finalized.intent_id IS NOT NULL THEN 'finalized'
    WHEN EXISTS(SELECT 1 FROM myfin.online_payment_events reconcile
      WHERE reconcile.company_id=i.company_id AND reconcile.intent_id=i.id
        AND reconcile.event_type='payment_reconciliation_required') THEN 'reconciliation_required'
    WHEN EXISTS(SELECT 1 FROM myfin.online_payment_events confirmed
      WHERE confirmed.company_id=i.company_id AND confirmed.intent_id=i.id
        AND confirmed.event_type='payment_confirmed') THEN 'confirmed_unposted'
    WHEN EXISTS(SELECT 1 FROM myfin.online_payment_events created
      WHERE created.company_id=i.company_id AND created.intent_id=i.id
        AND created.event_type='checkout_created') THEN 'pending'
    WHEN latest.event_type='checkout_creation_unknown' THEN 'reconciliation_required'
    WHEN latest.event_type='checkout_creation_failed' THEN 'failed'
    ELSE 'creating'
  END AS state,
  checkout.checkout_url,checkout.provider_payment_request_id,
  confirmed.provider_payment_id,confirmed.provider_method_code,
  confirmed.provider_status,coalesce(confirmed.provider_occurred_at,confirmed.created_at) AS confirmed_at,
  finalized.sale_id AS finalized_sale_id,finalized.created_at AS finalized_at,
  i.created_at
FROM myfin.online_payment_intents i
LEFT JOIN LATERAL (
  SELECT e.event_type FROM myfin.online_payment_events e
   WHERE e.company_id=i.company_id AND e.intent_id=i.id ORDER BY e.event_no DESC LIMIT 1
) latest ON true
LEFT JOIN LATERAL (
  SELECT e.checkout_url,e.provider_payment_request_id FROM myfin.online_payment_events e
   WHERE e.company_id=i.company_id AND e.intent_id=i.id AND e.event_type='checkout_created'
   ORDER BY e.event_no DESC LIMIT 1
) checkout ON true
LEFT JOIN LATERAL (
  SELECT e.provider_payment_id,e.provider_method_code,e.provider_status,e.provider_occurred_at,e.created_at
    FROM myfin.online_payment_events e
   WHERE e.company_id=i.company_id AND e.intent_id=i.id
     AND e.event_type IN ('payment_confirmed','payment_reconciliation_required')
   ORDER BY e.event_no DESC LIMIT 1
) confirmed ON true
LEFT JOIN LATERAL (
  SELECT f.intent_id,f.sale_id,f.created_at FROM myfin.online_payment_finalizations f
   WHERE f.company_id=i.company_id AND f.intent_id=i.id LIMIT 1
) finalized ON true;

-- Recipe reservation evidence stays immutable except for a monotonic expiry
-- extension that is anchored to an immutable online-payment intent hold.
CREATE OR REPLACE FUNCTION myfin.protect_customer_order_recipe_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'recipe_reservation_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR
     NEW.order_id IS DISTINCT FROM OLD.order_id OR
     NEW.line_no IS DISTINCT FROM OLD.line_no OR
     NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id OR
     NEW.recipe_id IS DISTINCT FROM OLD.recipe_id OR
     NEW.recipe_version IS DISTINCT FROM OLD.recipe_version OR
     NEW.line_quantity IS DISTINCT FROM OLD.line_quantity OR
     NEW.quantity_per_unit IS DISTINCT FROM OLD.quantity_per_unit OR
     NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity OR
     NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
    RAISE EXCEPTION 'recipe_reservation_evidence_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    IF OLD.state<>'active' OR NEW.state<>'active' OR NEW.expires_at<=OLD.expires_at OR
       NEW.released_at IS DISTINCT FROM OLD.released_at OR
       NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR
       NEW.release_reason IS DISTINCT FROM OLD.release_reason OR
       NOT EXISTS(
         SELECT 1 FROM myfin.online_payment_intents intent
          WHERE intent.company_id=OLD.company_id AND intent.order_id=OLD.order_id
            AND intent.hold_until=NEW.expires_at
       ) THEN
      RAISE EXCEPTION 'recipe_reservation_evidence_immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state<>'active' OR NEW.state NOT IN ('released','consumed') THEN
    RAISE EXCEPTION 'recipe_reservation_final' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON myfin.payment_gateway_connections,myfin.online_payment_intents,
  myfin.online_payment_events,myfin.online_payment_finalizations,
  myfin.customer_order_online_payment_state FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_online_payment_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_customer_order_recipe_reservation() FROM PUBLIC;

COMMENT ON COLUMN myfin.payment_gateway_connections.secret_ref IS
  'Lookup key in an operator-mounted secret file. API keys and webhook salts must never be stored in PostgreSQL.';
COMMENT ON TABLE myfin.online_payment_intents IS
  'Immutable authoritative order-total and opaque credential-reference snapshot. It is not a POS sale, receipt or accounting posting.';
COMMENT ON TABLE myfin.online_payment_events IS
  'Immutable sanitized gateway evidence. Raw webhook bodies and customer PII are not retained.';
COMMENT ON TABLE myfin.online_payment_finalizations IS
  'Immutable exactly-once link from verified gateway evidence to the ordinary POS sale posted by authorised staff.';
COMMENT ON VIEW myfin.customer_order_online_payment_state IS
  'Derived online payment state. A verified confirmation remains unposted until an authorised finalization links it to the ordinary POS sale.';
