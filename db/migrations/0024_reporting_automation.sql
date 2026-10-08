-- Company-scoped scheduled financial reports and immutable in-app snapshots.
-- Delivery is intentionally in-app only. No address, email or outbound channel
-- is stored here, and forecasts never trigger purchasing or stock mutations.

CREATE TABLE myfin.report_schedules (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  report_type text NOT NULL DEFAULT 'financial_summary'
    CHECK(report_type='financial_summary'),
  cadence text NOT NULL CHECK(cadence IN ('daily','weekly','monthly')),
  timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur'
    CHECK(timezone='Asia/Kuala_Lumpur'),
  local_time time without time zone NOT NULL,
  weekday smallint,
  month_day smallint,
  dimensions jsonb NOT NULL DEFAULT '["channel"]'::jsonb
    CHECK(jsonb_typeof(dimensions)='array'
      AND jsonb_array_length(dimensions) BETWEEN 1 AND 4
      AND dimensions <@ '["channel","paymentMethod","category","subcategory"]'::jsonb),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(filters)='object'),
  history_days smallint NOT NULL DEFAULT 84 CHECK(history_days BETWEEN 28 AND 366),
  forecast_horizon smallint NOT NULL DEFAULT 14 CHECK(forecast_horizon BETWEEN 1 AND 31),
  delivery_channel text NOT NULL DEFAULT 'in_app' CHECK(delivery_channel='in_app'),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  next_run_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  CHECK(extract(second FROM local_time)=0),
  CHECK((cadence='weekly' AND weekday IS NOT NULL AND weekday BETWEEN 1 AND 7 AND month_day IS NULL)
    OR (cadence='monthly' AND month_day IS NOT NULL AND month_day BETWEEN 1 AND 28 AND weekday IS NULL)
    OR (cadence='daily' AND weekday IS NULL AND month_day IS NULL)),
  CHECK(updated_at >= created_at)
);
CREATE INDEX report_schedules_due_idx
  ON myfin.report_schedules(next_run_at,company_id,id) WHERE enabled;

CREATE TABLE myfin.report_runs (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  schedule_id text NOT NULL,
  run_key text NOT NULL CHECK(run_key ~ '^[0-9a-f]{64}$'),
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','completed','failed','cancelled')),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 10),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL,
  lease_owner text CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  period_from date NOT NULL,
  period_to date NOT NULL,
  definition_snapshot jsonb NOT NULL CHECK(jsonb_typeof(definition_snapshot)='object'),
  result_snapshot jsonb,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,run_key),
  FOREIGN KEY(company_id,schedule_id)
    REFERENCES myfin.report_schedules(company_id,id) ON DELETE RESTRICT,
  CHECK(period_to >= period_from),
  CHECK(attempt_count <= max_attempts),
  CHECK((status='pending' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_snapshot IS NULL AND completed_at IS NULL)
    OR (status='running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND result_snapshot IS NULL AND completed_at IS NULL)
    OR (status='completed' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_snapshot IS NOT NULL AND jsonb_typeof(result_snapshot)='object'
      AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status='failed' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_snapshot IS NULL AND completed_at IS NULL AND error_code IS NOT NULL)
    OR (status='cancelled' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_snapshot IS NULL AND completed_at IS NOT NULL)),
  CHECK(updated_at >= created_at)
);
CREATE INDEX report_runs_queue_idx
  ON myfin.report_runs(next_attempt_at,scheduled_for,company_id,id)
  WHERE status IN ('pending','failed');
CREATE INDEX report_runs_expired_lease_idx
  ON myfin.report_runs(lease_expires_at,scheduled_for,company_id,id)
  WHERE status='running';
CREATE INDEX report_runs_company_history_idx
  ON myfin.report_runs(company_id,created_at DESC,id DESC);
CREATE INDEX report_runs_schedule_history_idx
  ON myfin.report_runs(company_id,schedule_id,scheduled_for DESC,id DESC);

CREATE FUNCTION myfin.protect_completed_report_run() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION 'completed_report_immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='completed' THEN
    RAISE EXCEPTION 'completed_report_immutable' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER immutable_completed_report_run
  BEFORE UPDATE OR DELETE ON myfin.report_runs
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_completed_report_run();
CREATE TRIGGER no_truncate_report_runs
  BEFORE TRUNCATE ON myfin.report_runs
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_completed_report_run();

REVOKE ALL ON myfin.report_schedules,myfin.report_runs FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_completed_report_run() FROM PUBLIC;
