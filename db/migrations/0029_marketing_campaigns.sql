-- Versioned marketing campaigns and audiences. Campaign attribution is tied to
-- exact promotion versions. It describes observed attribution, never causality.

CREATE TABLE myfin.marketing_audiences (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  company_id text,
  scope text NOT NULL CHECK(scope IN ('company','workspace')),
  version bigint NOT NULL CHECK(version > 0),
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,company_id) REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  CHECK((scope='company' AND company_id IS NOT NULL) OR (scope='workspace' AND company_id IS NULL))
);
CREATE INDEX marketing_audiences_company_idx
  ON myfin.marketing_audiences(workspace_id,company_id,updated_at DESC,id);

CREATE TABLE myfin.marketing_audience_versions (
  workspace_id text NOT NULL,
  audience_id text NOT NULL,
  version bigint NOT NULL CHECK(version > 0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  scope text NOT NULL CHECK(scope IN ('company','workspace')),
  company_id text,
  consent_criteria jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(consent_criteria)='object'),
  eligibility_criteria jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(eligibility_criteria)='object'),
  customer_criteria jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(customer_criteria)='object'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,audience_id,version),
  FOREIGN KEY(workspace_id,audience_id)
    REFERENCES myfin.marketing_audiences(workspace_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,company_id) REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  CHECK((scope='company' AND company_id IS NOT NULL) OR (scope='workspace' AND company_id IS NULL))
);
ALTER TABLE myfin.marketing_audiences ADD CONSTRAINT marketing_audiences_current_version_fk
  FOREIGN KEY(workspace_id,id,version)
  REFERENCES myfin.marketing_audience_versions(workspace_id,audience_id,version)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE myfin.marketing_campaigns (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  version bigint NOT NULL CHECK(version > 0),
  lifecycle text NOT NULL DEFAULT 'draft'
    CHECK(lifecycle IN ('draft','published','paused','completed','archived')),
  published_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  archived_at timestamptz,
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,id),
  UNIQUE(company_id,id),
  FOREIGN KEY(workspace_id,company_id) REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX marketing_campaigns_lifecycle_idx
  ON myfin.marketing_campaigns(workspace_id,company_id,lifecycle,updated_at DESC,id);

CREATE TABLE myfin.marketing_campaign_versions (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  campaign_id text NOT NULL,
  version bigint NOT NULL CHECK(version > 0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 4000),
  objective text NOT NULL CHECK(objective IN (
    'awareness','acquisition','conversion','repeat_purchase','basket_growth',
    'inventory_clearance','loyalty','win_back','custom'
  )),
  channels text[] NOT NULL CHECK(cardinality(channels) BETWEEN 1 AND 12)
    CHECK(channels <@ ARRAY['pos','storefront','email','sms','whatsapp','qr','social','in_store','other']::text[]),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  budget_sen bigint CHECK(budget_sen IS NULL OR budget_sen BETWEEN 0 AND 9000000000000000),
  currency_code text NOT NULL DEFAULT 'MYR' CHECK(currency_code ~ '^[A-Z]{3}$'),
  offer_kind text NOT NULL DEFAULT 'none'
    CHECK(offer_kind IN ('promotion','bonus_points','mixed','none')),
  bonus_points integer CHECK(bonus_points IS NULL OR bonus_points BETWEEN 1 AND 1000000),
  bonus_min_spend_sen bigint
    CHECK(bonus_min_spend_sen IS NULL OR bonus_min_spend_sen BETWEEN 0 AND 9000000000000000),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,campaign_id,version),
  FOREIGN KEY(workspace_id,company_id,campaign_id)
    REFERENCES myfin.marketing_campaigns(workspace_id,company_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(ends_at IS NULL OR ends_at > starts_at),
  CHECK((offer_kind IN ('bonus_points','mixed'))=(bonus_points IS NOT NULL)),
  CHECK(bonus_min_spend_sen IS NULL OR offer_kind IN ('bonus_points','mixed'))
);
CREATE INDEX marketing_campaign_versions_schedule_idx
  ON myfin.marketing_campaign_versions(workspace_id,company_id,starts_at,ends_at,campaign_id,version);
ALTER TABLE myfin.marketing_campaigns ADD CONSTRAINT marketing_campaigns_current_version_fk
  FOREIGN KEY(workspace_id,company_id,id,version)
  REFERENCES myfin.marketing_campaign_versions(workspace_id,company_id,campaign_id,version)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE myfin.marketing_campaign_version_promotions (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  campaign_id text NOT NULL,
  campaign_version bigint NOT NULL,
  promotion_id text NOT NULL,
  promotion_version bigint NOT NULL,
  PRIMARY KEY(workspace_id,company_id,campaign_id,campaign_version,promotion_id,promotion_version),
  FOREIGN KEY(workspace_id,company_id,campaign_id,campaign_version)
    REFERENCES myfin.marketing_campaign_versions(workspace_id,company_id,campaign_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT
);
CREATE INDEX marketing_campaign_promotion_attribution_idx
  ON myfin.marketing_campaign_version_promotions(
    workspace_id,company_id,promotion_id,promotion_version,campaign_id,campaign_version
  );

CREATE TABLE myfin.marketing_campaign_version_audiences (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  campaign_id text NOT NULL,
  campaign_version bigint NOT NULL,
  audience_id text NOT NULL,
  audience_version bigint NOT NULL,
  PRIMARY KEY(workspace_id,company_id,campaign_id,campaign_version,audience_id,audience_version),
  FOREIGN KEY(workspace_id,company_id,campaign_id,campaign_version)
    REFERENCES myfin.marketing_campaign_versions(workspace_id,company_id,campaign_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,audience_id,audience_version)
    REFERENCES myfin.marketing_audience_versions(workspace_id,audience_id,version) ON DELETE RESTRICT
);

CREATE TABLE myfin.marketing_campaign_events (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  campaign_id text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  campaign_version bigint NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('created','versioned','published','paused','completed','archived','cloned')),
  from_lifecycle text CHECK(from_lifecycle IS NULL OR from_lifecycle IN ('draft','published','paused','completed','archived')),
  to_lifecycle text NOT NULL CHECK(to_lifecycle IN ('draft','published','paused','completed','archived')),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,campaign_id,sequence),
  FOREIGN KEY(workspace_id,company_id,campaign_id)
    REFERENCES myfin.marketing_campaigns(workspace_id,company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,campaign_id,campaign_version)
    REFERENCES myfin.marketing_campaign_versions(workspace_id,company_id,campaign_id,version) ON DELETE RESTRICT
);
CREATE INDEX marketing_campaign_events_time_idx
  ON myfin.marketing_campaign_events(workspace_id,company_id,created_at DESC,campaign_id,sequence DESC);

CREATE FUNCTION myfin.enforce_marketing_audience_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.version<>1 THEN
    RAISE EXCEPTION 'audience_version_must_start_at_one' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id OR
       NEW.scope IS DISTINCT FROM OLD.scope OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'audience_identity_immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'audience_version_must_advance_once' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_audience_head_guard
  BEFORE INSERT OR UPDATE ON myfin.marketing_audiences
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_marketing_audience_head();

CREATE FUNCTION myfin.enforce_marketing_audience_version_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM myfin.marketing_audiences audience
     WHERE audience.workspace_id=NEW.workspace_id AND audience.id=NEW.audience_id
       AND audience.scope=NEW.scope AND audience.company_id IS NOT DISTINCT FROM NEW.company_id
  ) THEN
    RAISE EXCEPTION 'audience_scope_changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_audience_version_scope_guard
  BEFORE INSERT ON myfin.marketing_audience_versions
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_marketing_audience_version_scope();

CREATE FUNCTION myfin.enforce_marketing_campaign_audience_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM myfin.marketing_audience_versions audience
     WHERE audience.workspace_id=NEW.workspace_id AND audience.audience_id=NEW.audience_id
       AND audience.version=NEW.audience_version
       AND (audience.scope='workspace' OR audience.company_id=NEW.company_id)
  ) THEN
    RAISE EXCEPTION 'campaign_audience_scope_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_campaign_audience_scope_guard
  BEFORE INSERT ON myfin.marketing_campaign_version_audiences
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_marketing_campaign_audience_scope();

CREATE FUNCTION myfin.enforce_marketing_campaign_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.version<>1 THEN
    RAISE EXCEPTION 'campaign_version_must_start_at_one' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR
       NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'campaign_identity_immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.version<>OLD.version AND NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'campaign_version_must_advance_once' USING ERRCODE='23514';
    END IF;
    IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle AND NOT (
      (OLD.lifecycle='draft' AND NEW.lifecycle IN ('published','archived')) OR
      (OLD.lifecycle='published' AND NEW.lifecycle IN ('paused','completed')) OR
      (OLD.lifecycle='paused' AND NEW.lifecycle IN ('published','completed','archived')) OR
      (OLD.lifecycle='completed' AND NEW.lifecycle='archived')
    ) THEN
      RAISE EXCEPTION 'invalid_campaign_lifecycle_transition' USING ERRCODE='23514';
    END IF;
  END IF;
  IF (NEW.lifecycle='published' AND NEW.published_at IS NULL) OR
     (NEW.lifecycle='paused' AND NEW.paused_at IS NULL) OR
     (NEW.lifecycle='completed' AND NEW.completed_at IS NULL) OR
     (NEW.lifecycle='archived' AND NEW.archived_at IS NULL) THEN
    RAISE EXCEPTION 'campaign_lifecycle_timestamp_required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_campaign_head_guard
  BEFORE INSERT OR UPDATE ON myfin.marketing_campaigns
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_marketing_campaign_head();

CREATE FUNCTION myfin.protect_marketing_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'marketing_history_immutable' USING ERRCODE='23514';
END $$;

CREATE TRIGGER immutable_marketing_audience_versions BEFORE UPDATE OR DELETE ON myfin.marketing_audience_versions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER immutable_marketing_campaign_versions BEFORE UPDATE OR DELETE ON myfin.marketing_campaign_versions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER immutable_marketing_campaign_promotions BEFORE UPDATE OR DELETE ON myfin.marketing_campaign_version_promotions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER immutable_marketing_campaign_audiences BEFORE UPDATE OR DELETE ON myfin.marketing_campaign_version_audiences
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER immutable_marketing_campaign_events BEFORE UPDATE OR DELETE ON myfin.marketing_campaign_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER no_truncate_marketing_audience_versions BEFORE TRUNCATE ON myfin.marketing_audience_versions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER no_truncate_marketing_campaign_versions BEFORE TRUNCATE ON myfin.marketing_campaign_versions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER no_truncate_marketing_campaign_promotions BEFORE TRUNCATE ON myfin.marketing_campaign_version_promotions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER no_truncate_marketing_campaign_audiences BEFORE TRUNCATE ON myfin.marketing_campaign_version_audiences
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_marketing_history();
CREATE TRIGGER no_truncate_marketing_campaign_events BEFORE TRUNCATE ON myfin.marketing_campaign_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_marketing_history();

REVOKE ALL ON myfin.marketing_audiences,myfin.marketing_audience_versions,
  myfin.marketing_campaigns,myfin.marketing_campaign_versions,
  myfin.marketing_campaign_version_promotions,myfin.marketing_campaign_version_audiences,
  myfin.marketing_campaign_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE myfin.marketing_campaign_events_sequence_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_marketing_audience_head() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_marketing_audience_version_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_marketing_campaign_audience_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_marketing_campaign_head() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_marketing_history() FROM PUBLIC;

COMMENT ON TABLE myfin.marketing_campaign_versions IS
  'Immutable campaign definitions. Results are attributed through exact linked promotion versions and are not causal lift estimates.';
COMMENT ON TABLE myfin.marketing_audience_versions IS
  'Immutable, consent-aware audience criteria. Customer membership is evaluated at use time; raw contact data is not copied here.';
COMMENT ON TABLE myfin.marketing_campaign_events IS
  'Append-only campaign lifecycle audit history.';
