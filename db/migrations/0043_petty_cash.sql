-- Petty-cash funds and expense settlements are financial evidence. Fund entries
-- and payment events are append-only; balances and expense payment state are
-- derived inside the same database transaction that records each event.

ALTER TABLE myfin.expenses DROP CONSTRAINT expense_status_type;
ALTER TABLE myfin.expenses DROP CONSTRAINT expense_pending_is_credit;
ALTER TABLE myfin.expenses DROP CONSTRAINT expense_paid_on_shape;
ALTER TABLE myfin.expenses DROP CONSTRAINT expense_paid_by_type;
UPDATE myfin.expenses SET status='pending_payment' WHERE status='pending';
ALTER TABLE myfin.expenses ADD COLUMN paid_amount_sen bigint NOT NULL DEFAULT 0;
ALTER TABLE myfin.expenses ADD COLUMN petty_cash_fund_id text;
-- New interactive expense records use their client-generated id as the
-- request identity. The original request digest remains immutable so an
-- ambiguous retry can replay the existing expense without repeating its
-- initial payment or petty-cash withdrawal.
ALTER TABLE myfin.expenses ADD COLUMN create_request_digest text
  CHECK(create_request_digest IS NULL OR create_request_digest ~ '^[0-9a-f]{64}$');
UPDATE myfin.expenses
   SET paid_amount_sen=CASE WHEN status='paid' THEN amount_sen ELSE 0 END;
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_status_type
  CHECK(status IN ('draft','pending_payment','partially_paid','paid'));
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_paid_by_type
  CHECK(paid_by_type IN ('unassigned','legacy_unspecified','app_user','non_user','petty_cash','other','credit'));
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_paid_amount_range
  CHECK(paid_amount_sen BETWEEN 0 AND amount_sen);
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_paid_on_shape
  CHECK((status='paid' AND paid_on IS NOT NULL) OR (status<>'paid' AND paid_on IS NULL));

CREATE TABLE myfin.petty_cash_funds (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  currency_code text NOT NULL DEFAULT 'MYR' CHECK(currency_code ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  is_default boolean NOT NULL DEFAULT false,
  low_balance_threshold_sen bigint NOT NULL DEFAULT 0
    CHECK(low_balance_threshold_sen BETWEEN 0 AND 100000000000000),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,idempotency_key),
  FOREIGN KEY(company_id) REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  CHECK((status='open' AND closed_at IS NULL AND closed_by IS NULL)
     OR (status='closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL))
);
CREATE UNIQUE INDEX petty_cash_funds_default_idx
  ON myfin.petty_cash_funds(company_id) WHERE is_default AND status='open';
CREATE INDEX petty_cash_funds_status_idx ON myfin.petty_cash_funds(company_id,status,name,id);
ALTER TABLE myfin.expenses ADD CONSTRAINT expenses_petty_cash_fund_fk
  FOREIGN KEY(company_id,petty_cash_fund_id)
  REFERENCES myfin.petty_cash_funds(company_id,id) ON DELETE RESTRICT;

CREATE FUNCTION myfin.protect_expense_create_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.create_request_digest IS DISTINCT FROM OLD.create_request_digest THEN
    RAISE EXCEPTION 'expense_create_identity_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION myfin.protect_expense_create_identity() FROM PUBLIC;
CREATE TRIGGER protect_expense_create_identity
  BEFORE UPDATE OF created_by,create_request_digest ON myfin.expenses
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_expense_create_identity();

CREATE TABLE myfin.expense_payment_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  expense_id text NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('payment','reversal')),
  amount_sen bigint NOT NULL CHECK(amount_sen BETWEEN 1 AND 100000000000000),
  source_type text NOT NULL CHECK(source_type IN
    ('legacy_unspecified','app_user','non_user','petty_cash','other','bank','card','credit')),
  paid_by_identity_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  paid_by_name text NOT NULL DEFAULT '' CHECK(length(paid_by_name)<=500),
  petty_cash_fund_id text,
  reference text NOT NULL DEFAULT '' CHECK(length(reference)<=500),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  reverses_event_id text,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  occurred_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,idempotency_key),
  UNIQUE(company_id,reverses_event_id),
  FOREIGN KEY(company_id,expense_id)
    REFERENCES myfin.expenses(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,petty_cash_fund_id)
    REFERENCES myfin.petty_cash_funds(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,reverses_event_id)
    REFERENCES myfin.expense_payment_events(company_id,id) ON DELETE RESTRICT,
  CHECK((source_type='app_user')=(paid_by_identity_id IS NOT NULL)),
  CHECK(source_type NOT IN ('non_user','other') OR length(btrim(paid_by_name))>0),
  CHECK((source_type='petty_cash')=(petty_cash_fund_id IS NOT NULL)),
  CHECK((event_type='payment' AND reverses_event_id IS NULL)
     OR (event_type='reversal' AND reverses_event_id IS NOT NULL))
);
CREATE INDEX expense_payment_events_expense_idx
  ON myfin.expense_payment_events(company_id,expense_id,occurred_on,created_at,id);
CREATE INDEX expense_payment_events_fund_idx
  ON myfin.expense_payment_events(company_id,petty_cash_fund_id,created_at,id)
  WHERE petty_cash_fund_id IS NOT NULL;

-- Seed immutable settlement evidence for records that predate payment events.
INSERT INTO myfin.expense_payment_events(company_id,id,expense_id,event_type,amount_sen,
  source_type,paid_by_identity_id,paid_by_name,reference,reason,idempotency_key,
  request_digest,actor_id,occurred_on,created_at)
SELECT company_id,'legacy-payment-'||md5(company_id||':'||id),id,'payment',amount_sen,
  CASE WHEN paid_by_type='petty_cash' THEN 'other' ELSE paid_by_type END,
  CASE WHEN paid_by_type='app_user' THEN paid_by_identity_id ELSE NULL END,
  CASE
    WHEN paid_by_type='petty_cash' THEN 'Legacy petty cash (unallocated)'
    WHEN paid_by_type IN ('non_user','other') THEN coalesce(nullif(btrim(paid_by_name),''),'Legacy / unspecified')
    ELSE coalesce(paid_by_name,'')
  END,
  '','Migrated paid expense','legacy-'||md5(company_id||':'||id),
  md5(company_id||':'||id)||md5(id||':'||company_id),created_by,
  coalesce(paid_on,myfin.valid_expense_date(data->>'date')),updated_at
FROM myfin.expenses WHERE status='paid' AND amount_sen>0;

CREATE TABLE myfin.petty_cash_entries (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  fund_id text NOT NULL,
  entry_type text NOT NULL CHECK(entry_type IN
    ('opening_balance','replenishment','expense_disbursement','adjustment_in','adjustment_out',
     'reconciliation','reversal','reopen','close')),
  signed_amount_sen bigint NOT NULL CHECK(signed_amount_sen BETWEEN -100000000000000 AND 100000000000000),
  amount_sen bigint NOT NULL CHECK(amount_sen=abs(signed_amount_sen)),
  balance_after_sen bigint NOT NULL CHECK(balance_after_sen BETWEEN 0 AND 100000000000000),
  counted_balance_sen bigint CHECK(counted_balance_sen BETWEEN 0 AND 100000000000000),
  expense_id text,
  expense_payment_event_id text,
  reverses_entry_id text,
  reference text NOT NULL DEFAULT '' CHECK(length(reference)<=500),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,fund_id,idempotency_key),
  UNIQUE(company_id,reverses_entry_id),
  UNIQUE(company_id,expense_payment_event_id),
  FOREIGN KEY(company_id,fund_id)
    REFERENCES myfin.petty_cash_funds(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,expense_id)
    REFERENCES myfin.expenses(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,expense_payment_event_id)
    REFERENCES myfin.expense_payment_events(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,reverses_entry_id)
    REFERENCES myfin.petty_cash_entries(company_id,id) ON DELETE RESTRICT,
  CHECK(
    (entry_type='opening_balance' AND signed_amount_sen>=0)
    OR (entry_type IN ('replenishment','adjustment_in') AND signed_amount_sen>0)
    OR (entry_type IN ('expense_disbursement','adjustment_out') AND signed_amount_sen<0)
    OR entry_type IN ('reconciliation','reversal')
    OR (entry_type='reopen' AND signed_amount_sen=0)
    OR (entry_type='close' AND signed_amount_sen=0)
  ),
  CHECK((entry_type='reconciliation')=(counted_balance_sen IS NOT NULL)),
  CHECK((entry_type='expense_disbursement' AND expense_id IS NOT NULL AND expense_payment_event_id IS NOT NULL)
     OR (entry_type='reversal' AND (expense_id IS NULL)=(expense_payment_event_id IS NULL))
     OR (entry_type NOT IN ('expense_disbursement','reversal')
         AND expense_id IS NULL AND expense_payment_event_id IS NULL)),
  CHECK((entry_type='reversal')=(reverses_entry_id IS NOT NULL))
);
CREATE INDEX petty_cash_entries_fund_history_idx
  ON myfin.petty_cash_entries(company_id,fund_id,occurred_at,id);
CREATE INDEX petty_cash_entries_expense_idx
  ON myfin.petty_cash_entries(company_id,expense_id,id) WHERE expense_id IS NOT NULL;

CREATE FUNCTION myfin.validate_expense_payment_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE original myfin.expense_payment_events%ROWTYPE;
BEGIN
  IF NEW.event_type='reversal' THEN
    SELECT * INTO original FROM myfin.expense_payment_events
     WHERE company_id=NEW.company_id AND id=NEW.reverses_event_id FOR SHARE;
    IF NOT FOUND OR original.event_type<>'payment' OR original.expense_id<>NEW.expense_id
       OR original.amount_sen<>NEW.amount_sen OR original.source_type<>NEW.source_type
       OR original.paid_by_identity_id IS DISTINCT FROM NEW.paid_by_identity_id
       OR original.paid_by_name<>NEW.paid_by_name
       OR original.petty_cash_fund_id IS DISTINCT FROM NEW.petty_cash_fund_id THEN
      RAISE EXCEPTION 'expense_payment_reversal_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_expense_payment_event_before_insert
  BEFORE INSERT ON myfin.expense_payment_events
  FOR EACH ROW EXECUTE FUNCTION myfin.validate_expense_payment_event();

CREATE FUNCTION myfin.enforce_petty_cash_entry_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE fund_status text; current_balance bigint; original myfin.petty_cash_entries%ROWTYPE;
  payment myfin.expense_payment_events%ROWTYPE;
BEGIN
  SELECT status INTO fund_status FROM myfin.petty_cash_funds
   WHERE company_id=NEW.company_id AND id=NEW.fund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'petty_cash_fund_not_found' USING ERRCODE='23503'; END IF;
  IF fund_status<>'open' THEN RAISE EXCEPTION 'petty_cash_fund_closed' USING ERRCODE='23514'; END IF;
  IF (NEW.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date <
     ((SELECT opened_at FROM myfin.petty_cash_funds
        WHERE company_id=NEW.company_id AND id=NEW.fund_id) AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN
    RAISE EXCEPTION 'petty_cash_entry_before_fund_opened' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(sum(signed_amount_sen),0)::bigint INTO current_balance
    FROM myfin.petty_cash_entries WHERE company_id=NEW.company_id AND fund_id=NEW.fund_id;
  IF NEW.entry_type='opening_balance' AND EXISTS(
    SELECT 1 FROM myfin.petty_cash_entries WHERE company_id=NEW.company_id AND fund_id=NEW.fund_id
  ) THEN RAISE EXCEPTION 'petty_cash_opening_exists' USING ERRCODE='23514'; END IF;
  IF NEW.entry_type='reversal' THEN
    SELECT * INTO original FROM myfin.petty_cash_entries
     WHERE company_id=NEW.company_id AND fund_id=NEW.fund_id AND id=NEW.reverses_entry_id FOR SHARE;
    IF NOT FOUND OR original.entry_type IN ('opening_balance','close','reversal')
       OR original.signed_amount_sen=0 OR NEW.signed_amount_sen<>-original.signed_amount_sen THEN
      RAISE EXCEPTION 'petty_cash_reversal_mismatch' USING ERRCODE='23514';
    END IF;
    IF (original.entry_type='expense_disbursement')<>(NEW.expense_payment_event_id IS NOT NULL) THEN
      RAISE EXCEPTION 'petty_cash_reversal_payment_required' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.expense_payment_event_id IS NOT NULL THEN
    SELECT * INTO payment FROM myfin.expense_payment_events
     WHERE company_id=NEW.company_id AND id=NEW.expense_payment_event_id FOR SHARE;
    IF NOT FOUND OR payment.expense_id<>NEW.expense_id OR payment.petty_cash_fund_id<>NEW.fund_id
       OR payment.amount_sen<>NEW.amount_sen
       OR (NEW.entry_type='expense_disbursement' AND payment.event_type<>'payment')
       OR (NEW.entry_type='reversal' AND (payment.event_type<>'reversal'
           OR payment.reverses_event_id<>original.expense_payment_event_id)) THEN
      RAISE EXCEPTION 'petty_cash_expense_payment_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF current_balance+NEW.signed_amount_sen<0 THEN
    RAISE EXCEPTION 'petty_cash_insufficient_balance' USING ERRCODE='23514';
  END IF;
  IF NEW.balance_after_sen<>current_balance+NEW.signed_amount_sen THEN
    RAISE EXCEPTION 'petty_cash_balance_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.entry_type='reconciliation' AND NEW.counted_balance_sen<>NEW.balance_after_sen THEN
    RAISE EXCEPTION 'petty_cash_reconciliation_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.entry_type='close' AND current_balance<>0 THEN
    RAISE EXCEPTION 'petty_cash_balance_not_zero' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_petty_cash_entry_balance_before_insert
  BEFORE INSERT ON myfin.petty_cash_entries
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_petty_cash_entry_balance();

CREATE FUNCTION myfin.protect_petty_cash_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'petty_cash_entry_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_petty_cash_entry
  BEFORE UPDATE OR DELETE ON myfin.petty_cash_entries
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_petty_cash_entry();

CREATE FUNCTION myfin.protect_expense_payment_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'expense_payment_event_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_expense_payment_event
  BEFORE UPDATE OR DELETE ON myfin.expense_payment_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_expense_payment_event();

-- Payment state is always re-derived from immutable events. Reversed payments
-- contribute zero, and the final settlement date is the latest active payment.
CREATE FUNCTION myfin.sync_expense_payment_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE total_paid bigint; total_due bigint; settlement_date date; next_status text;
BEGIN
  SELECT coalesce(sum(CASE WHEN p.event_type='payment' THEN p.amount_sen ELSE -p.amount_sen END),0),
         max(p.occurred_on) FILTER (WHERE p.event_type='payment' AND r.id IS NULL)
    INTO total_paid,settlement_date
    FROM myfin.expense_payment_events p
    LEFT JOIN myfin.expense_payment_events r
      ON r.company_id=p.company_id AND r.reverses_event_id=p.id
   WHERE p.company_id=NEW.company_id AND p.expense_id=NEW.expense_id;
  SELECT amount_sen INTO total_due FROM myfin.expenses
   WHERE company_id=NEW.company_id AND id=NEW.expense_id FOR UPDATE;
  IF total_paid<0 OR total_paid>total_due THEN
    RAISE EXCEPTION 'expense_payment_total_invalid' USING ERRCODE='23514';
  END IF;
  next_status:=CASE WHEN total_paid=0 THEN 'pending_payment'
                    WHEN total_paid<total_due THEN 'partially_paid'
                    ELSE 'paid' END;
  UPDATE myfin.expenses
     SET paid_amount_sen=total_paid,status=next_status,
         paid_on=CASE WHEN next_status='paid' THEN settlement_date ELSE NULL END
   WHERE company_id=NEW.company_id AND id=NEW.expense_id;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_expense_payment_state_after_insert
  AFTER INSERT ON myfin.expense_payment_events
  FOR EACH ROW EXECUTE FUNCTION myfin.sync_expense_payment_state();

-- Keep the document-shaped API synchronized while typed columns remain the
-- reporting and integrity boundary.
DROP TRIGGER sync_expense_lifecycle_before_write ON myfin.expenses;
CREATE OR REPLACE FUNCTION myfin.sync_expense_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.status='paid' AND NEW.paid_on IS NULL THEN
    NEW.paid_on:=myfin.valid_expense_date(NEW.data->>'date');
  END IF;
  NEW.amount_sen:=round(NEW.amount*100)::bigint;
  NEW.data:=NEW.data || jsonb_build_object(
    'amount',NEW.amount,
    'status',NEW.status,
    'effectiveStatus',CASE
      WHEN NEW.voided_at IS NOT NULL THEN 'voided'
      WHEN NEW.status IN ('pending_payment','partially_paid')
        AND NEW.credit_due_date IS NOT NULL AND NEW.credit_due_date<current_date THEN 'overdue'
      ELSE NEW.status END,
    'paidAmountSen',NEW.paid_amount_sen,
    'outstandingAmountSen',NEW.amount_sen-NEW.paid_amount_sen,
    'paidByType',NEW.paid_by_type,
    'paidByUserId',coalesce(NEW.paid_by_identity_id,''),
    'paidByName',coalesce(NEW.paid_by_name,''),
    'pettyCashFundId',coalesce(NEW.petty_cash_fund_id,''),
    'creditTermsDays',NEW.credit_terms_days,
    'creditDueDate',coalesce(NEW.credit_due_date::text,''),
    'paidOn',coalesce(NEW.paid_on::text,'')
  );
  IF TG_OP='UPDATE' THEN
    NEW.version:=OLD.version+1;
    NEW.updated_at:=now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_expense_lifecycle_before_write
  BEFORE INSERT OR UPDATE OF amount,data,status,paid_amount_sen,paid_by_type,paid_by_identity_id,
    paid_by_name,petty_cash_fund_id,credit_terms_days,credit_due_date,paid_on,
    voided_at,voided_by,void_reason ON myfin.expenses
  FOR EACH ROW EXECUTE FUNCTION myfin.sync_expense_lifecycle();

UPDATE myfin.expenses SET data=data || jsonb_build_object(
  'status',status,'effectiveStatus',CASE
    WHEN voided_at IS NOT NULL THEN 'voided'
    WHEN status IN ('pending_payment','partially_paid')
      AND credit_due_date IS NOT NULL AND credit_due_date<current_date THEN 'overdue'
    ELSE status END,
  'paidAmountSen',paid_amount_sen,'outstandingAmountSen',amount_sen-paid_amount_sen,
  'pettyCashFundId',coalesce(petty_cash_fund_id,''));

CREATE FUNCTION myfin.assert_expense_payment_state() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE current_row record;
BEGIN
  SELECT status,amount_sen,paid_amount_sen,paid_on INTO current_row
    FROM myfin.expenses WHERE company_id=NEW.company_id AND id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF (current_row.status='draft' AND current_row.paid_amount_sen<>0)
     OR (current_row.status='pending_payment' AND current_row.paid_amount_sen<>0)
     OR (current_row.status='partially_paid'
         AND NOT (current_row.paid_amount_sen>0 AND current_row.paid_amount_sen<current_row.amount_sen))
     OR (current_row.status='paid'
         AND NOT (current_row.paid_amount_sen=current_row.amount_sen AND current_row.paid_on IS NOT NULL)) THEN
    RAISE EXCEPTION 'expense_payment_state_inconsistent' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_payment_state_consistent
  AFTER INSERT OR UPDATE OF amount_sen,status,paid_amount_sen,paid_on ON myfin.expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION myfin.assert_expense_payment_state();

ALTER TABLE myfin.expense_events DROP CONSTRAINT expense_events_action_check;
ALTER TABLE myfin.expense_events ADD CONSTRAINT expense_events_action_check
  CHECK(action IN ('created','updated','settled','voided','imported','payment_recorded','payment_reversed'));

REVOKE ALL ON FUNCTION myfin.protect_petty_cash_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_expense_payment_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.validate_expense_payment_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_petty_cash_entry_balance() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.sync_expense_payment_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.assert_expense_payment_state() FROM PUBLIC;
