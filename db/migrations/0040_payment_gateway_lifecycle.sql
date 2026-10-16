-- Bounded, provider-backed reconciliation lifecycle for hosted checkouts.
-- Scheduling state is mutable operational metadata; every provider observation,
-- lookup failure and escalation remains append-only in online_payment_events.

ALTER TABLE myfin.online_payment_events
  DROP CONSTRAINT online_payment_events_event_type_check;
ALTER TABLE myfin.online_payment_events
  ADD CONSTRAINT online_payment_events_event_type_check CHECK(event_type IN (
    'checkout_creation_started','checkout_created','checkout_creation_failed','checkout_creation_unknown',
    'checkout_discovered','provider_status_observed','provider_reconciliation_failed',
    'operator_escalation_required',
    'webhook_rejected','payment_confirmed','payment_reconciliation_required'
  ));

ALTER TABLE myfin.online_payment_events
  DROP CONSTRAINT online_payment_events_failure_code_check;
ALTER TABLE myfin.online_payment_events
  ADD CONSTRAINT online_payment_events_failure_code_check CHECK(failure_code IN (
    '','provider_request_rejected','provider_outcome_unknown','provider_response_invalid',
    'provider_unavailable','provider_request_not_found','reconciliation_budget_exhausted',
    'completed_without_signed_webhook',
    'amount_mismatch','currency_mismatch','reference_mismatch','payment_request_mismatch',
    'payment_not_succeeded','order_not_payable'
  ));

ALTER TABLE myfin.online_payment_events
  DROP CONSTRAINT online_payment_events_check;
ALTER TABLE myfin.online_payment_events
  ADD CONSTRAINT online_payment_events_check CHECK(
    (event_type='checkout_creation_started' AND provider_payment_request_id IS NULL AND
      checkout_url IS NULL AND failure_code='') OR
    (event_type='checkout_created' AND provider_payment_request_id IS NOT NULL AND
      checkout_url IS NOT NULL AND provider_status='pending' AND failure_code='') OR
    (event_type='checkout_creation_failed' AND provider_payment_request_id IS NULL AND
      checkout_url IS NULL AND failure_code='provider_request_rejected') OR
    (event_type='checkout_creation_unknown' AND provider_payment_request_id IS NULL AND
      checkout_url IS NULL AND failure_code='provider_outcome_unknown') OR
    (event_type='checkout_discovered' AND provider_event_key IS NOT NULL AND
      payload_digest IS NOT NULL AND provider_payment_request_id IS NOT NULL AND
      provider_payment_id IS NULL AND provider_method_code='' AND
      provider_status IN ('pending','completed','failed','expired','canceled','inactive') AND
      checkout_url IS NOT NULL AND observed_amount_sen IS NOT NULL AND
      observed_currency_code='MYR' AND failure_code='') OR
    (event_type='provider_status_observed' AND provider_event_key IS NOT NULL AND
      payload_digest IS NOT NULL AND provider_payment_request_id IS NOT NULL AND
      provider_payment_id IS NULL AND provider_method_code='' AND
      provider_status IN ('pending','completed','failed','expired','canceled','inactive') AND
      checkout_url IS NULL AND observed_amount_sen IS NOT NULL AND
      observed_currency_code='MYR' AND failure_code='') OR
    (event_type='provider_reconciliation_failed' AND provider_event_key IS NOT NULL AND
      payload_digest IS NOT NULL AND provider_payment_id IS NULL AND
      provider_method_code='' AND provider_status='' AND checkout_url IS NULL AND
      observed_amount_sen IS NULL AND observed_currency_code IS NULL AND
      failure_code IN ('provider_request_rejected','provider_response_invalid','provider_unavailable',
        'provider_request_not_found','amount_mismatch','currency_mismatch','reference_mismatch',
        'payment_request_mismatch')) OR
    (event_type='operator_escalation_required' AND provider_event_key IS NOT NULL AND
      payload_digest IS NOT NULL AND provider_payment_id IS NULL AND provider_method_code='' AND
      provider_status IN ('','completed') AND checkout_url IS NULL AND
      observed_amount_sen IS NULL AND observed_currency_code IS NULL AND
      failure_code IN ('reconciliation_budget_exhausted','completed_without_signed_webhook',
        'provider_request_rejected','provider_response_invalid','amount_mismatch',
        'currency_mismatch','reference_mismatch','payment_request_mismatch')) OR
    (event_type='webhook_rejected' AND provider_event_key IS NOT NULL AND payload_digest IS NOT NULL AND
      failure_code NOT IN ('','provider_unavailable')) OR
    (event_type IN ('payment_confirmed','payment_reconciliation_required') AND
      provider_event_key IS NOT NULL AND payload_digest IS NOT NULL AND
      provider_payment_request_id IS NOT NULL AND provider_payment_id IS NOT NULL AND
      provider_method_code<>'' AND provider_status='completed' AND
      observed_amount_sen IS NOT NULL AND observed_currency_code='MYR' AND
      ((event_type='payment_confirmed' AND failure_code='') OR
       (event_type='payment_reconciliation_required' AND failure_code='order_not_payable')))
  );

CREATE TABLE myfin.online_payment_reconciliation_jobs (
  company_id text NOT NULL,
  intent_id text NOT NULL,
  state text NOT NULL DEFAULT 'scheduled'
    CHECK(state IN ('scheduled','running','retry_wait','terminal_unpaid','operator_escalation','closed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 24),
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  budget_expires_at timestamptz NOT NULL,
  lease_owner text CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  last_outcome_code text NOT NULL DEFAULT '' CHECK(last_outcome_code IN (
    '','pending','completed','failed','expired','canceled','inactive',
    'provider_request_rejected','provider_response_invalid','provider_unavailable',
    'provider_request_not_found','amount_mismatch','currency_mismatch',
    'reference_mismatch','payment_request_mismatch','reconciliation_budget_exhausted',
    'completed_without_signed_webhook'
  )),
  escalation_reason text NOT NULL DEFAULT '' CHECK(escalation_reason IN (
    '','reconciliation_budget_exhausted','completed_without_signed_webhook',
    'provider_request_rejected','provider_response_invalid','amount_mismatch',
    'currency_mismatch','reference_mismatch','payment_request_mismatch'
  )),
  escalated_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,intent_id),
  FOREIGN KEY(company_id,intent_id)
    REFERENCES myfin.online_payment_intents(company_id,id) ON DELETE RESTRICT,
  CHECK(budget_expires_at>created_at),
  CHECK((state='running')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK(state<>'operator_escalation' OR
    (escalated_at IS NOT NULL AND escalation_reason<>'')),
  CHECK(state NOT IN ('terminal_unpaid','closed') OR resolved_at IS NOT NULL)
);
CREATE INDEX online_payment_reconciliation_due_idx
  ON myfin.online_payment_reconciliation_jobs(next_attempt_at,company_id,intent_id)
  WHERE state IN ('scheduled','retry_wait','running');
CREATE INDEX online_payment_reconciliation_escalation_idx
  ON myfin.online_payment_reconciliation_jobs(escalated_at,company_id,intent_id)
  WHERE state='operator_escalation';

REVOKE ALL ON myfin.online_payment_reconciliation_jobs FROM PUBLIC;

COMMENT ON TABLE myfin.online_payment_reconciliation_jobs IS
  'Bounded, non-PII retry scheduling and durable operator-escalation state. Provider evidence remains append-only in online_payment_events.';
COMMENT ON COLUMN myfin.online_payment_reconciliation_jobs.budget_expires_at IS
  'After this instant unresolved or unknown outcomes escalate; elapsed time never proves that a provider payment failed.';
