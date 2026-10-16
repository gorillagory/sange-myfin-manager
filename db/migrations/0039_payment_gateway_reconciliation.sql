-- Immutable provider-backed status observations close abandoned and ambiguous
-- HitPay checkouts without treating local elapsed time as evidence of failure.
-- A status lookup never substitutes for the signed completion webhook.

ALTER TABLE myfin.online_payment_events
  DROP CONSTRAINT online_payment_events_event_type_check;
ALTER TABLE myfin.online_payment_events
  ADD CONSTRAINT online_payment_events_event_type_check CHECK(event_type IN (
    'checkout_creation_started','checkout_created','checkout_creation_failed','checkout_creation_unknown',
    'checkout_discovered','provider_status_observed',
    'webhook_rejected','payment_confirmed','payment_reconciliation_required'
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

DROP INDEX myfin.online_payment_checkout_request_unique;
CREATE UNIQUE INDEX online_payment_checkout_request_unique
  ON myfin.online_payment_events(company_id,provider_payment_request_id)
  WHERE event_type IN ('checkout_created','checkout_discovered');

DROP INDEX myfin.online_payment_checkout_once;
CREATE UNIQUE INDEX online_payment_checkout_once
  ON myfin.online_payment_events(company_id,intent_id)
  WHERE event_type IN ('checkout_created','checkout_discovered');

CREATE OR REPLACE VIEW myfin.customer_order_online_payment_state
WITH (security_barrier=true) AS
SELECT i.company_id,i.order_id,i.id AS intent_id,i.connection_id,i.amount_sen,i.currency_code,i.hold_until,
  CASE
    WHEN finalized.intent_id IS NOT NULL THEN 'finalized'
    WHEN EXISTS(SELECT 1 FROM myfin.online_payment_events reconcile
      WHERE reconcile.company_id=i.company_id AND reconcile.intent_id=i.id
        AND reconcile.event_type='payment_reconciliation_required') THEN 'reconciliation_required'
    WHEN EXISTS(SELECT 1 FROM myfin.online_payment_events confirmed_event
      WHERE confirmed_event.company_id=i.company_id AND confirmed_event.intent_id=i.id
        AND confirmed_event.event_type='payment_confirmed') THEN 'confirmed_unposted'
    WHEN observed.provider_status='completed' THEN 'reconciliation_required'
    WHEN observed.provider_status IN ('failed','expired','canceled','inactive') THEN 'failed'
    WHEN checkout.provider_payment_request_id IS NOT NULL THEN 'pending'
    WHEN latest.event_type='checkout_creation_unknown' THEN 'reconciliation_required'
    WHEN latest.event_type='checkout_creation_failed' THEN 'failed'
    ELSE 'creating'
  END AS state,
  checkout.checkout_url,checkout.provider_payment_request_id,
  confirmed.provider_payment_id,confirmed.provider_method_code,
  coalesce(confirmed.provider_status,observed.provider_status,'') AS provider_status,
  coalesce(confirmed.provider_occurred_at,confirmed.created_at) AS confirmed_at,
  finalized.sale_id AS finalized_sale_id,finalized.created_at AS finalized_at,
  i.created_at
FROM myfin.online_payment_intents i
LEFT JOIN LATERAL (
  SELECT e.event_type FROM myfin.online_payment_events e
   WHERE e.company_id=i.company_id AND e.intent_id=i.id ORDER BY e.event_no DESC LIMIT 1
) latest ON true
LEFT JOIN LATERAL (
  SELECT e.checkout_url,e.provider_payment_request_id FROM myfin.online_payment_events e
   WHERE e.company_id=i.company_id AND e.intent_id=i.id
     AND e.event_type IN ('checkout_created','checkout_discovered')
   ORDER BY e.event_no DESC LIMIT 1
) checkout ON true
LEFT JOIN LATERAL (
  SELECT e.provider_status FROM myfin.online_payment_events e
   WHERE e.company_id=i.company_id AND e.intent_id=i.id
     AND e.event_type IN ('checkout_discovered','provider_status_observed')
   -- Once the API has reported completion, no contradictory later lookup may
   -- unlock counter tender. Only the signed webhook can confirm and post it.
   ORDER BY CASE WHEN e.provider_status='completed' THEN 0 ELSE 1 END,e.event_no DESC LIMIT 1
) observed ON true
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

COMMENT ON VIEW myfin.customer_order_online_payment_state IS
  'Derived online payment state. Provider lookups may prove a request terminal and unpaid, but only a signed completion webhook creates confirmed payment evidence.';
