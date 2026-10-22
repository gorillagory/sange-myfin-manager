-- Location assignment, staff attendance, terminal occupancy and cash-drawer
-- reconciliation are separate concepts.  Amounts use integer sen so a close
-- can never differ because of floating-point arithmetic.
CREATE TABLE myfin.staff_location_assignments (
  company_id text NOT NULL,
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  store_id text NOT NULL,
  store_location_id text NOT NULL,
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY(company_id,identity_id,store_location_id),
  FOREIGN KEY(company_id,identity_id) REFERENCES myfin.memberships(company_id,identity_id) ON DELETE CASCADE,
  FOREIGN KEY(company_id,store_id) REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX staff_location_active_idx ON myfin.staff_location_assignments(company_id,store_location_id,identity_id)
  WHERE revoked_at IS NULL;

CREATE TABLE myfin.staff_work_shifts (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  store_id text NOT NULL,
  store_location_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','on_break','closed')),
  clocked_in_at timestamptz NOT NULL DEFAULT now(),
  break_started_at timestamptz,
  break_seconds integer NOT NULL DEFAULT 0 CHECK(break_seconds>=0),
  clocked_out_at timestamptz,
  opened_terminal_id text NOT NULL,
  closed_terminal_id text,
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,identity_id,store_id,store_location_id,id),
  FOREIGN KEY(company_id,store_id) REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id,opened_terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id,closed_terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  CHECK((status='closed')=(clocked_out_at IS NOT NULL)),
  CHECK((status='on_break')=(break_started_at IS NOT NULL))
);
CREATE UNIQUE INDEX staff_work_shift_open_identity_idx ON myfin.staff_work_shifts(company_id,identity_id)
  WHERE status IN ('open','on_break');

CREATE TABLE myfin.terminal_staff_sessions (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  terminal_id text NOT NULL,
  store_id text NOT NULL,
  store_location_id text NOT NULL,
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  work_shift_id text,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_reason text NOT NULL DEFAULT '' CHECK(length(ended_reason)<=120),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,id,terminal_id,store_id,store_location_id,identity_id),
  FOREIGN KEY(company_id,store_id,store_location_id,terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id) REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,identity_id,store_id,store_location_id,work_shift_id)
    REFERENCES myfin.staff_work_shifts(company_id,identity_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  CHECK((status='ended')=(ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX terminal_staff_session_active_terminal_idx ON myfin.terminal_staff_sessions(company_id,terminal_id)
  WHERE status='active';
CREATE UNIQUE INDEX terminal_staff_session_active_identity_idx ON myfin.terminal_staff_sessions(company_id,identity_id)
  WHERE status='active';

CREATE TABLE myfin.register_shifts (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  terminal_id text NOT NULL,
  store_id text NOT NULL,
  store_location_id text NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','force_closed')),
  opening_cash_sen bigint NOT NULL CHECK(opening_cash_sen BETWEEN 0 AND 1000000000000000),
  expected_cash_sen bigint,
  counted_cash_sen bigint,
  variance_sen bigint,
  opened_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  opened_staff_session_id text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  closed_at timestamptz,
  variance_reason text NOT NULL DEFAULT '' CHECK(length(variance_reason)<=1000),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
  close_request_id text CHECK(close_request_id IS NULL OR length(close_request_id) BETWEEN 1 AND 128),
  close_request_digest text CHECK(close_request_digest IS NULL OR length(close_request_digest)=64),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,id,terminal_id,store_id,store_location_id),
  UNIQUE(company_id,close_request_id),
  FOREIGN KEY(company_id,store_id,store_location_id,terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id) REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,opened_staff_session_id,terminal_id,store_id,store_location_id,opened_by)
    REFERENCES myfin.terminal_staff_sessions(company_id,id,terminal_id,store_id,store_location_id,identity_id) ON DELETE RESTRICT,
  CHECK((close_request_id IS NULL)=(close_request_digest IS NULL)),
  CHECK((status='open' AND closed_at IS NULL AND expected_cash_sen IS NULL AND counted_cash_sen IS NULL AND variance_sen IS NULL) OR
    (status IN ('closed','force_closed') AND closed_at IS NOT NULL AND expected_cash_sen IS NOT NULL AND counted_cash_sen IS NOT NULL AND variance_sen=counted_cash_sen-expected_cash_sen))
);
CREATE UNIQUE INDEX register_shift_open_terminal_idx ON myfin.register_shifts(company_id,terminal_id)
  WHERE status='open';
CREATE INDEX register_shift_history_idx ON myfin.register_shifts(company_id,store_id,business_date DESC,opened_at DESC);

CREATE TABLE myfin.staff_shift_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  work_shift_id text NOT NULL,
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  terminal_id text NOT NULL,
  store_id text NOT NULL,
  store_location_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('clock_in','break_start','break_end','clock_out','force_clock_out')),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,identity_id,store_id,store_location_id,work_shift_id)
    REFERENCES myfin.staff_work_shifts(company_id,identity_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id,terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT
);
CREATE INDEX staff_shift_events_history_idx ON myfin.staff_shift_events(company_id,work_shift_id,created_at,id);

CREATE TABLE myfin.register_shift_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  register_shift_id text NOT NULL,
  terminal_id text NOT NULL,
  store_id text NOT NULL,
  store_location_id text NOT NULL,
  staff_session_id text NOT NULL,
  staff_identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('opened','joined','cash_entry','closed','force_closed')),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  request_id text NOT NULL DEFAULT '' CHECK(length(request_id)<=128),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,register_shift_id,terminal_id,store_id,store_location_id)
    REFERENCES myfin.register_shifts(company_id,id,terminal_id,store_id,store_location_id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,staff_session_id,terminal_id,store_id,store_location_id,staff_identity_id)
    REFERENCES myfin.terminal_staff_sessions(company_id,id,terminal_id,store_id,store_location_id,identity_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX register_shift_events_request_key ON myfin.register_shift_events(company_id,register_shift_id,request_id)
  WHERE request_id<>'';
CREATE INDEX register_shift_events_history_idx ON myfin.register_shift_events(company_id,register_shift_id,created_at,id);

CREATE FUNCTION myfin.protect_shift_event() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'shift_event_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_staff_shift_event BEFORE UPDATE OR DELETE ON myfin.staff_shift_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_shift_event();
CREATE TRIGGER immutable_register_shift_event BEFORE UPDATE OR DELETE ON myfin.register_shift_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_shift_event();

CREATE TABLE myfin.register_cash_entries (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  register_shift_id text NOT NULL,
  terminal_id text NOT NULL,
  store_id text NOT NULL,
  store_location_id text NOT NULL,
  staff_session_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('opening_float','cash_sale','cash_refund','paid_in','paid_out','adjustment')),
  amount_sen bigint NOT NULL CHECK(amount_sen BETWEEN -1000000000000000 AND 1000000000000000),
  source_type text NOT NULL DEFAULT '' CHECK(length(source_type)<=80),
  source_id text NOT NULL DEFAULT '' CHECK(length(source_id)<=128),
  request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,register_shift_id,request_id),
  FOREIGN KEY(company_id,register_shift_id,terminal_id,store_id,store_location_id)
    REFERENCES myfin.register_shifts(company_id,id,terminal_id,store_id,store_location_id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id,terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id) REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,staff_session_id,terminal_id,store_id,store_location_id,actor_id)
    REFERENCES myfin.terminal_staff_sessions(company_id,id,terminal_id,store_id,store_location_id,identity_id) ON DELETE RESTRICT,
  CHECK((source_type='' AND source_id='') OR (source_type<>'' AND source_id<>'')),
  CHECK((kind='opening_float' AND amount_sen>=0) OR
    (kind IN ('cash_sale','paid_in') AND amount_sen>0) OR
    (kind IN ('cash_refund','paid_out') AND amount_sen<0) OR
    (kind='adjustment' AND amount_sen<>0))
);
CREATE INDEX register_cash_entries_shift_idx ON myfin.register_cash_entries(company_id,register_shift_id,created_at,id);
CREATE UNIQUE INDEX register_cash_entries_source_key ON myfin.register_cash_entries(company_id,source_type,source_id)
  WHERE source_type<>'';

CREATE FUNCTION myfin.protect_register_cash_entry() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'register_cash_entry_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_register_cash_entry BEFORE UPDATE OR DELETE ON myfin.register_cash_entries
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_register_cash_entry();

-- A paid receipt may wait for review after the originating cashier has signed
-- out. Persist only server-resolved origin context; approval later replays it
-- instead of borrowing the approver's current terminal or drawer.
ALTER TABLE myfin.receipt_reviews
  ADD COLUMN origin_store_id text,
  ADD COLUMN origin_store_location_id text,
  ADD COLUMN origin_terminal_id text,
  ADD COLUMN origin_terminal_credential_version integer,
  ADD COLUMN origin_staff_session_id text,
  ADD COLUMN origin_work_shift_id text,
  ADD COLUMN origin_register_shift_id text,
  ADD COLUMN origin_snapshot jsonb CHECK(origin_snapshot IS NULL OR jsonb_typeof(origin_snapshot)='object'),
  ADD COLUMN origin_pos_session_created_at timestamptz,
  ADD COLUMN origin_register_policy_required boolean NOT NULL DEFAULT false,
  ADD COLUMN origin_register_policy_from timestamptz,
  -- Existing rows and inserts from a rollback API have no terminal context.
  -- Encode that compatibility in the column default instead of updating
  -- immutable paid-intent rows after the column is added.
  ADD COLUMN origin_legacy boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT receipt_reviews_origin_terminal_context_fk FOREIGN KEY(company_id,origin_store_id,
    origin_store_location_id,origin_terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT receipt_reviews_origin_credential_fk FOREIGN KEY(company_id,origin_terminal_id,origin_terminal_credential_version)
    REFERENCES myfin.terminal_credentials(company_id,terminal_id,version) ON DELETE RESTRICT,
  ADD CONSTRAINT receipt_reviews_origin_staff_context_fk FOREIGN KEY(company_id,origin_staff_session_id,
    origin_terminal_id,origin_store_id,origin_store_location_id,actor_id)
    REFERENCES myfin.terminal_staff_sessions(company_id,id,terminal_id,store_id,store_location_id,identity_id) ON DELETE RESTRICT,
  ADD CONSTRAINT receipt_reviews_origin_work_context_fk FOREIGN KEY(company_id,actor_id,origin_store_id,
    origin_store_location_id,origin_work_shift_id)
    REFERENCES myfin.staff_work_shifts(company_id,identity_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT receipt_reviews_origin_register_context_fk FOREIGN KEY(company_id,origin_register_shift_id,
    origin_terminal_id,origin_store_id,origin_store_location_id)
    REFERENCES myfin.register_shifts(company_id,id,terminal_id,store_id,store_location_id) ON DELETE RESTRICT,
  ADD CONSTRAINT receipt_reviews_origin_shape CHECK(
    (origin_terminal_id IS NULL AND origin_store_id IS NULL AND origin_store_location_id IS NULL
      AND origin_terminal_credential_version IS NULL AND origin_staff_session_id IS NULL
      AND origin_work_shift_id IS NULL AND origin_register_shift_id IS NULL AND origin_snapshot IS NULL) OR
    (origin_terminal_id IS NOT NULL AND origin_store_id IS NOT NULL AND origin_store_location_id IS NOT NULL
      AND origin_terminal_credential_version>0 AND origin_staff_session_id IS NOT NULL AND origin_snapshot IS NOT NULL));
ALTER TABLE myfin.receipt_reviews ADD CONSTRAINT receipt_reviews_origin_legacy_shape
  CHECK(origin_legacy=(origin_terminal_id IS NULL));
ALTER TABLE myfin.receipt_reviews ADD CONSTRAINT receipt_reviews_origin_register_policy_shape
  CHECK(NOT origin_register_policy_required OR origin_register_policy_from IS NOT NULL);

ALTER TABLE myfin.pos_sessions
  ADD COLUMN staff_session_id text,
  ADD COLUMN work_shift_id text,
  ADD COLUMN register_shift_id text,
  ADD CONSTRAINT pos_sessions_staff_session_fk FOREIGN KEY(company_id,staff_session_id)
    REFERENCES myfin.terminal_staff_sessions(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_staff_context_fk FOREIGN KEY(company_id,staff_session_id,terminal_id,store_id,store_location_id,identity_id)
    REFERENCES myfin.terminal_staff_sessions(company_id,id,terminal_id,store_id,store_location_id,identity_id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_work_shift_fk FOREIGN KEY(company_id,work_shift_id)
    REFERENCES myfin.staff_work_shifts(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_register_shift_fk FOREIGN KEY(company_id,register_shift_id)
    REFERENCES myfin.register_shifts(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_work_context_fk FOREIGN KEY(company_id,identity_id,store_id,store_location_id,work_shift_id)
    REFERENCES myfin.staff_work_shifts(company_id,identity_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_register_context_fk FOREIGN KEY(company_id,register_shift_id,terminal_id,store_id,store_location_id)
    REFERENCES myfin.register_shifts(company_id,id,terminal_id,store_id,store_location_id) ON DELETE RESTRICT;

ALTER TABLE myfin.transactions
  ADD COLUMN store_id text,
  ADD COLUMN store_location_id text,
  ADD COLUMN terminal_id text,
  ADD COLUMN terminal_credential_version integer,
  ADD COLUMN staff_session_id text,
  ADD COLUMN work_shift_id text,
  ADD COLUMN register_shift_id text,
  ADD CONSTRAINT transactions_store_fk FOREIGN KEY(company_id,store_id)
    REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_store_location_fk FOREIGN KEY(company_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_terminal_fk FOREIGN KEY(company_id,terminal_id)
    REFERENCES myfin.terminals(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_terminal_context_fk FOREIGN KEY(company_id,store_id,store_location_id,terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_terminal_credential_fk FOREIGN KEY(company_id,terminal_id,terminal_credential_version)
    REFERENCES myfin.terminal_credentials(company_id,terminal_id,version) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_staff_session_fk FOREIGN KEY(company_id,staff_session_id)
    REFERENCES myfin.terminal_staff_sessions(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_staff_context_fk FOREIGN KEY(company_id,staff_session_id,terminal_id,store_id,store_location_id,actor_id)
    REFERENCES myfin.terminal_staff_sessions(company_id,id,terminal_id,store_id,store_location_id,identity_id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_work_shift_fk FOREIGN KEY(company_id,work_shift_id)
    REFERENCES myfin.staff_work_shifts(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_register_shift_fk FOREIGN KEY(company_id,register_shift_id)
    REFERENCES myfin.register_shifts(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_work_context_fk FOREIGN KEY(company_id,actor_id,store_id,store_location_id,work_shift_id)
    REFERENCES myfin.staff_work_shifts(company_id,identity_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_register_context_fk FOREIGN KEY(company_id,register_shift_id,terminal_id,store_id,store_location_id)
    REFERENCES myfin.register_shifts(company_id,id,terminal_id,store_id,store_location_id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_terminal_attribution_shape CHECK(
    (terminal_id IS NULL AND terminal_credential_version IS NULL AND store_id IS NULL AND store_location_id IS NULL AND staff_session_id IS NULL AND work_shift_id IS NULL AND register_shift_id IS NULL) OR
    (terminal_id IS NOT NULL AND terminal_credential_version>0 AND store_id IS NOT NULL AND store_location_id IS NOT NULL AND staff_session_id IS NOT NULL));
CREATE INDEX transactions_terminal_time_idx ON myfin.transactions(company_id,terminal_id,id)
  WHERE terminal_id IS NOT NULL;

CREATE FUNCTION myfin.protect_transaction_attribution() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF (OLD.store_id,OLD.store_location_id,OLD.terminal_id,OLD.terminal_credential_version,OLD.staff_session_id,OLD.work_shift_id,OLD.register_shift_id)
    IS DISTINCT FROM
    (NEW.store_id,NEW.store_location_id,NEW.terminal_id,NEW.terminal_credential_version,NEW.staff_session_id,NEW.work_shift_id,NEW.register_shift_id) THEN
    RAISE EXCEPTION 'transaction_attribution_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_transaction_attribution BEFORE UPDATE OF store_id,store_location_id,terminal_id,terminal_credential_version,staff_session_id,work_shift_id,register_shift_id
  ON myfin.transactions FOR EACH ROW EXECUTE FUNCTION myfin.protect_transaction_attribution();
