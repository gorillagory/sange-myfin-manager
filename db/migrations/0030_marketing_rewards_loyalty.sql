-- Free-item offers are represented as an exact promotion-version rule. The
-- reward must already be a cart line, so the normal order and recipe stock
-- reservations cover it. Only the configured quantity can be discounted.
ALTER TABLE myfin.promotion_versions
  ADD COLUMN reward_product_id text,
  ADD COLUMN reward_variant_id text,
  ADD COLUMN reward_quantity_milli bigint;

DO $$
DECLARE promotion_constraint record;
BEGIN
  FOR promotion_constraint IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='myfin.promotion_versions'::regclass AND contype='c'
       AND pg_get_constraintdef(oid) LIKE '%discount_type%'
  LOOP
    EXECUTE format('ALTER TABLE myfin.promotion_versions DROP CONSTRAINT %I',
      promotion_constraint.conname);
  END LOOP;
END $$;

ALTER TABLE myfin.promotion_versions
  ADD CONSTRAINT promotion_versions_discount_shape CHECK(
    (discount_type='percentage' AND discount_basis_points BETWEEN 1 AND 10000
      AND discount_sen IS NULL AND reward_product_id IS NULL
      AND reward_variant_id IS NULL AND reward_quantity_milli IS NULL)
    OR
    (discount_type='fixed' AND discount_basis_points IS NULL
      AND discount_sen BETWEEN 1 AND 9000000000000000
      AND reward_product_id IS NULL AND reward_variant_id IS NULL
      AND reward_quantity_milli IS NULL)
    OR
    (discount_type='free_item' AND discount_basis_points IS NULL
      AND discount_sen IS NULL AND max_discount_sen IS NULL
      AND reward_product_id IS NOT NULL
      AND reward_quantity_milli BETWEEN 1 AND 1000000000)
  ),
  ADD CONSTRAINT promotion_versions_reward_product_fk
    FOREIGN KEY(company_id,reward_product_id)
      REFERENCES myfin.products(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT promotion_versions_reward_variant_fk
    FOREIGN KEY(company_id,reward_product_id,reward_variant_id)
      REFERENCES myfin.product_variants(company_id,product_id,id) ON DELETE RESTRICT;

CREATE FUNCTION myfin.validate_free_item_redemption() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  rule myfin.promotion_versions%ROWTYPE;
  target_sequence integer;
  reward_line_count integer;
  wrong_line_count integer;
  expected_discount bigint;
BEGIN
  SELECT * INTO STRICT rule FROM myfin.promotion_versions
   WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
     AND promotion_id=NEW.promotion_id AND version=NEW.promotion_version;
  IF rule.discount_type<>'free_item' THEN RETURN NEW; END IF;

  SELECT sequence INTO STRICT target_sequence
    FROM myfin.pricing_snapshot_discounts
   WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
     AND snapshot_id=NEW.pricing_snapshot_id AND promotion_id=NEW.promotion_id
     AND promotion_version=NEW.promotion_version;

  SELECT count(*),
         count(*) FILTER(WHERE l.product_id<>rule.reward_product_id OR
           l.variant_id IS DISTINCT FROM rule.reward_variant_id),
         coalesce(sum(least(
           l.gross_sen-coalesce((SELECT sum(prior.discount_sen)
             FROM myfin.pricing_snapshot_discount_lines prior
             WHERE prior.workspace_id=l.workspace_id AND prior.company_id=l.company_id
               AND prior.snapshot_id=l.snapshot_id AND prior.line_no=l.line_no
               AND prior.discount_sequence<target_sequence),0),
           round((l.unit_price_sen::numeric*least(l.quantity_milli,rule.reward_quantity_milli)::numeric)/1000)::bigint
         )),0)
    INTO reward_line_count,wrong_line_count,expected_discount
    FROM myfin.pricing_snapshot_discount_lines dl
    JOIN myfin.pricing_snapshot_lines l
      ON l.workspace_id=dl.workspace_id AND l.company_id=dl.company_id
     AND l.snapshot_id=dl.snapshot_id AND l.line_no=dl.line_no
   WHERE dl.workspace_id=NEW.workspace_id AND dl.company_id=NEW.company_id
     AND dl.snapshot_id=NEW.pricing_snapshot_id
     AND dl.discount_sequence=target_sequence;

  IF reward_line_count<>1 OR wrong_line_count<>0 OR
     expected_discount<>NEW.discount_sen OR expected_discount<=0 THEN
    RAISE EXCEPTION 'free_item_pricing_changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_free_item_promotion_redemption
  BEFORE INSERT ON myfin.promotion_redemptions
  FOR EACH ROW EXECUTE FUNCTION myfin.validate_free_item_redemption();

-- Preserve the old stamp columns as compatibility projections while making
-- the current workspace rule versioned and expressive enough for points.
ALTER TABLE myfin.workspace_loyalty_settings
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD COLUMN unit_label text NOT NULL DEFAULT 'points',
  ADD COLUMN earn_mode text NOT NULL DEFAULT 'per_order',
  ADD COLUMN points_per_order integer NOT NULL DEFAULT 1,
  ADD COLUMN spend_step_sen bigint NOT NULL DEFAULT 100,
  ADD COLUMN points_per_spend_step integer NOT NULL DEFAULT 1,
  ADD COLUMN minimum_spend_sen bigint NOT NULL DEFAULT 0,
  ADD COLUMN redemption_threshold_points integer NOT NULL DEFAULT 10;

UPDATE myfin.workspace_loyalty_settings
   SET unit_label='stamps',earn_mode='per_order',points_per_order=stamps_per_order,
       minimum_spend_sen=round(minimum_spend*100)::bigint,
       redemption_threshold_points=stamps_required;

-- These legacy columns remain compatibility projections of the points rule.
-- Broaden their original stamp-era checks so every valid points configuration
-- can still be projected without making older readers fail.
DO $$
DECLARE legacy_constraint record;
BEGIN
  FOR legacy_constraint IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='myfin.workspace_loyalty_settings'::regclass AND contype='c'
       AND (pg_get_constraintdef(oid) LIKE '%stamps_required%'
         OR pg_get_constraintdef(oid) LIKE '%minimum_spend%')
  LOOP
    EXECUTE format('ALTER TABLE myfin.workspace_loyalty_settings DROP CONSTRAINT %I',
      legacy_constraint.conname);
  END LOOP;
END $$;

ALTER TABLE myfin.workspace_loyalty_settings
  ADD CONSTRAINT workspace_loyalty_settings_legacy_threshold_check
    CHECK(stamps_required BETWEEN 1 AND 1000000000),
  ADD CONSTRAINT workspace_loyalty_settings_legacy_minimum_spend_check
    CHECK(minimum_spend BETWEEN 0 AND 90000000000000),
  ADD CONSTRAINT workspace_loyalty_settings_version_check CHECK(version>0),
  ADD CONSTRAINT workspace_loyalty_settings_unit_label_check
    CHECK(length(btrim(unit_label)) BETWEEN 1 AND 40),
  ADD CONSTRAINT workspace_loyalty_settings_earn_mode_check
    CHECK(earn_mode IN ('per_order','spend_step')),
  ADD CONSTRAINT workspace_loyalty_settings_points_per_order_check
    CHECK(points_per_order BETWEEN 1 AND 1000000),
  ADD CONSTRAINT workspace_loyalty_settings_spend_step_check
    CHECK(spend_step_sen BETWEEN 1 AND 9000000000000000),
  ADD CONSTRAINT workspace_loyalty_settings_points_per_step_check
    CHECK(points_per_spend_step BETWEEN 1 AND 1000000),
  ADD CONSTRAINT workspace_loyalty_settings_minimum_spend_check
    CHECK(minimum_spend_sen BETWEEN 0 AND 9000000000000000),
  ADD CONSTRAINT workspace_loyalty_settings_redemption_threshold_check
    CHECK(redemption_threshold_points BETWEEN 1 AND 1000000000);

CREATE TABLE myfin.workspace_loyalty_setting_versions (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK(version>0),
  enabled boolean NOT NULL,
  unit_label text NOT NULL CHECK(length(btrim(unit_label)) BETWEEN 1 AND 40),
  earn_mode text NOT NULL CHECK(earn_mode IN ('per_order','spend_step')),
  points_per_order integer NOT NULL CHECK(points_per_order BETWEEN 1 AND 1000000),
  spend_step_sen bigint NOT NULL CHECK(spend_step_sen BETWEEN 1 AND 9000000000000000),
  points_per_spend_step integer NOT NULL CHECK(points_per_spend_step BETWEEN 1 AND 1000000),
  minimum_spend_sen bigint NOT NULL CHECK(minimum_spend_sen BETWEEN 0 AND 9000000000000000),
  redemption_threshold_points integer NOT NULL CHECK(redemption_threshold_points BETWEEN 1 AND 1000000000),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,version)
);

INSERT INTO myfin.workspace_loyalty_setting_versions(
  workspace_id,version,enabled,unit_label,earn_mode,points_per_order,spend_step_sen,
  points_per_spend_step,minimum_spend_sen,redemption_threshold_points,request_digest,created_by,created_at)
SELECT workspace_id,version,enabled,unit_label,earn_mode,points_per_order,spend_step_sen,
       points_per_spend_step,minimum_spend_sen,redemption_threshold_points,
       md5(workspace_id||':legacy-loyalty')||md5('legacy-loyalty:'||workspace_id),updated_by,updated_at
  FROM myfin.workspace_loyalty_settings;

CREATE FUNCTION myfin.protect_loyalty_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'loyalty_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_workspace_loyalty_setting_versions
  BEFORE UPDATE OR DELETE ON myfin.workspace_loyalty_setting_versions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_loyalty_history();
CREATE TRIGGER no_truncate_workspace_loyalty_setting_versions
  BEFORE TRUNCATE ON myfin.workspace_loyalty_setting_versions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_loyalty_history();

ALTER TABLE myfin.customer_loyalty_accounts
  ADD COLUMN reserved_points integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT customer_loyalty_reserved_points_check
    CHECK(reserved_points BETWEEN 0 AND stamp_balance);

CREATE TABLE myfin.loyalty_point_events (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('earn','bonus','redeem','adjust','reverse')),
  points integer NOT NULL CHECK(points<>0 AND points BETWEEN -1000000000 AND 1000000000),
  balance_after integer NOT NULL CHECK(balance_after BETWEEN 0 AND 1000000000),
  reserved_after integer NOT NULL CHECK(reserved_after BETWEEN 0 AND balance_after),
  source_sale_id text,
  source_order_id text,
  campaign_id text,
  campaign_version bigint,
  promotion_id text,
  promotion_version bigint,
  program_id text,
  program_version bigint,
  reverses_event_id text,
  legacy_event_id text,
  actor_type text NOT NULL CHECK(actor_type IN ('system','staff','customer')),
  staff_actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  customer_actor_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,idempotency_key),
  UNIQUE(workspace_id,reverses_event_id),
  UNIQUE(workspace_id,legacy_event_id),
  FOREIGN KEY(workspace_id,company_id)
    REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,customer_id)
    REFERENCES myfin.customer_loyalty_accounts(workspace_id,customer_id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,source_sale_id)
    REFERENCES myfin.transactions(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,source_order_id)
    REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,campaign_id,campaign_version)
    REFERENCES myfin.marketing_campaign_versions(workspace_id,company_id,campaign_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,program_version)
    REFERENCES myfin.workspace_loyalty_setting_versions(workspace_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,reverses_event_id)
    REFERENCES myfin.loyalty_point_events(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,legacy_event_id)
    REFERENCES myfin.customer_loyalty_events(workspace_id,id) ON DELETE RESTRICT,
  CHECK((campaign_id IS NULL)=(campaign_version IS NULL)),
  CHECK((promotion_id IS NULL)=(promotion_version IS NULL)),
  CHECK((program_id IS NULL)=(program_version IS NULL)),
  CHECK(program_id IS NULL OR program_id='workspace-loyalty'),
  CHECK((actor_type='system' AND staff_actor_id IS NULL AND customer_actor_id IS NULL) OR
        (actor_type='staff' AND staff_actor_id IS NOT NULL AND customer_actor_id IS NULL) OR
        (actor_type='customer' AND staff_actor_id IS NULL AND customer_actor_id=customer_id)),
  CHECK(kind NOT IN ('adjust','redeem') OR actor_type<>'staff' OR length(btrim(reason))>=3),
  CHECK((kind IN ('earn','bonus') AND points>0) OR
        (kind='redeem' AND points<0) OR kind IN ('adjust','reverse'))
);
CREATE UNIQUE INDEX loyalty_point_base_sale_once
  ON myfin.loyalty_point_events(workspace_id,company_id,source_sale_id)
  WHERE kind='earn' AND source_sale_id IS NOT NULL AND campaign_id IS NULL;
CREATE UNIQUE INDEX loyalty_point_campaign_sale_once
  ON myfin.loyalty_point_events(workspace_id,company_id,source_sale_id,campaign_id,campaign_version)
  WHERE kind='bonus' AND source_sale_id IS NOT NULL;
CREATE INDEX loyalty_point_customer_history_idx
  ON myfin.loyalty_point_events(workspace_id,customer_id,occurred_at DESC,id DESC);
CREATE INDEX loyalty_point_campaign_history_idx
  ON myfin.loyalty_point_events(workspace_id,company_id,campaign_id,campaign_version,occurred_at DESC)
  WHERE campaign_id IS NOT NULL;

INSERT INTO myfin.loyalty_point_events(
  workspace_id,company_id,id,customer_id,kind,points,balance_after,reserved_after,
  source_sale_id,legacy_event_id,actor_type,staff_actor_id,reason,idempotency_key,request_digest,
  occurred_at,created_at)
SELECT workspace_id,company_id,id,customer_id,
       CASE kind WHEN 'earn' THEN 'earn' WHEN 'redeem' THEN 'redeem'
         WHEN 'reverse' THEN 'reverse' ELSE 'adjust' END,
       stamps,balance_after,0,source_sale_id,id,
       CASE WHEN actor_id IS NULL THEN 'system' ELSE 'staff' END,actor_id,
       CASE WHEN length(btrim(reason))>0 THEN reason ELSE 'Legacy loyalty event' END,
       md5(workspace_id||':'||id)||md5('legacy-event:'||workspace_id||':'||id),
       md5(id||':'||workspace_id)||md5('legacy-request:'||id||':'||workspace_id),
       created_at,created_at
  FROM myfin.customer_loyalty_events;

CREATE FUNCTION myfin.enforce_loyalty_point_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  account myfin.customer_loyalty_accounts%ROWTYPE;
  original myfin.loyalty_point_events%ROWTYPE;
BEGIN
  SELECT * INTO STRICT account FROM myfin.customer_loyalty_accounts
   WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
  IF account.stamp_balance<>NEW.balance_after OR account.reserved_points<>NEW.reserved_after THEN
    RAISE EXCEPTION 'loyalty_balance_changed' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='reverse' THEN
    IF NEW.reverses_event_id IS NULL THEN
      RAISE EXCEPTION 'loyalty_reversal_source_required' USING ERRCODE='23514';
    END IF;
    SELECT * INTO STRICT original FROM myfin.loyalty_point_events
     WHERE workspace_id=NEW.workspace_id AND id=NEW.reverses_event_id;
    IF original.kind='reverse' OR original.customer_id<>NEW.customer_id OR
       original.company_id<>NEW.company_id OR NEW.points<>-original.points THEN
      RAISE EXCEPTION 'invalid_loyalty_reversal' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.reverses_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_loyalty_reversal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_loyalty_point_event_insert
  BEFORE INSERT ON myfin.loyalty_point_events
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_loyalty_point_event();
CREATE TRIGGER immutable_loyalty_point_events
  BEFORE UPDATE OR DELETE ON myfin.loyalty_point_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_loyalty_history();
CREATE TRIGGER no_truncate_loyalty_point_events
  BEFORE TRUNCATE ON myfin.loyalty_point_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_loyalty_history();

-- One immutable batch closes the zero-award idempotency gap and makes the
-- settings/campaign decision at the original sale authoritative on retries.
CREATE TABLE myfin.loyalty_sale_award_batches (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  source_sale_id text NOT NULL,
  source_order_id text NOT NULL,
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  total_sen bigint NOT NULL CHECK(total_sen BETWEEN 0 AND 9000000000000000),
  program_version bigint NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,source_sale_id),
  FOREIGN KEY(workspace_id,company_id)
    REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,source_sale_id)
    REFERENCES myfin.transactions(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,source_order_id)
    REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,program_version)
    REFERENCES myfin.workspace_loyalty_setting_versions(workspace_id,version) ON DELETE RESTRICT
);
CREATE TRIGGER immutable_loyalty_sale_award_batches
  BEFORE UPDATE OR DELETE ON myfin.loyalty_sale_award_batches
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_loyalty_history();
CREATE TRIGGER no_truncate_loyalty_sale_award_batches
  BEFORE TRUNCATE ON myfin.loyalty_sale_award_batches
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_loyalty_history();

CREATE TABLE myfin.loyalty_point_reservations (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  points integer NOT NULL CHECK(points BETWEEN 1 AND 1000000000),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','consumed','released','expired')),
  source_order_id text,
  campaign_id text,
  campaign_version bigint,
  promotion_id text,
  promotion_version bigint,
  program_id text NOT NULL DEFAULT 'workspace-loyalty' CHECK(program_id='workspace-loyalty'),
  program_version bigint NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_event_id text,
  release_reason text CHECK(release_reason IS NULL OR length(btrim(release_reason)) BETWEEN 3 AND 500),
  staff_actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  customer_actor_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,idempotency_key),
  UNIQUE(workspace_id,consumed_event_id),
  FOREIGN KEY(workspace_id,company_id)
    REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,customer_id)
    REFERENCES myfin.customer_loyalty_accounts(workspace_id,customer_id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,source_order_id)
    REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,campaign_id,campaign_version)
    REFERENCES myfin.marketing_campaign_versions(workspace_id,company_id,campaign_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,program_version)
    REFERENCES myfin.workspace_loyalty_setting_versions(workspace_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,consumed_event_id)
    REFERENCES myfin.loyalty_point_events(workspace_id,id) ON DELETE RESTRICT,
  CHECK((campaign_id IS NULL)=(campaign_version IS NULL)),
  CHECK((promotion_id IS NULL)=(promotion_version IS NULL)),
  CHECK((staff_actor_id IS NULL)<>(customer_actor_id IS NULL)),
  CHECK((state='active' AND consumed_event_id IS NULL AND consumed_at IS NULL AND released_at IS NULL) OR
        (state='consumed' AND consumed_event_id IS NOT NULL AND consumed_at IS NOT NULL AND released_at IS NULL) OR
        (state IN ('released','expired') AND consumed_event_id IS NULL AND consumed_at IS NULL AND released_at IS NOT NULL))
);
CREATE UNIQUE INDEX loyalty_point_active_order_reservation
  ON myfin.loyalty_point_reservations(company_id,source_order_id)
  WHERE state='active' AND source_order_id IS NOT NULL;
CREATE INDEX loyalty_point_active_reservations_idx
  ON myfin.loyalty_point_reservations(workspace_id,customer_id,expires_at,id)
  WHERE state='active';
CREATE INDEX loyalty_point_expiry_sweep_idx
  ON myfin.loyalty_point_reservations(workspace_id,expires_at,id)
  WHERE state='active';

CREATE FUNCTION myfin.enforce_loyalty_point_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  consumed_event myfin.loyalty_point_events%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'loyalty_reservation_history_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' THEN
      RAISE EXCEPTION 'loyalty_reservation_history_immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.id IS DISTINCT FROM OLD.id OR
     NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.points IS DISTINCT FROM OLD.points OR
     NEW.source_order_id IS DISTINCT FROM OLD.source_order_id OR
     NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR
     NEW.campaign_version IS DISTINCT FROM OLD.campaign_version OR
     NEW.promotion_id IS DISTINCT FROM OLD.promotion_id OR
     NEW.promotion_version IS DISTINCT FROM OLD.promotion_version OR
     NEW.program_id IS DISTINCT FROM OLD.program_id OR
     NEW.program_version IS DISTINCT FROM OLD.program_version OR
     NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
     NEW.request_digest IS DISTINCT FROM OLD.request_digest OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
     NEW.staff_actor_id IS DISTINCT FROM OLD.staff_actor_id OR
     NEW.customer_actor_id IS DISTINCT FROM OLD.customer_actor_id OR
     NEW.reserved_at IS DISTINCT FROM OLD.reserved_at OR OLD.state<>'active' OR NEW.state='active' THEN
    RAISE EXCEPTION 'loyalty_reservation_history_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state='consumed' THEN
    SELECT * INTO consumed_event FROM myfin.loyalty_point_events
     WHERE workspace_id=NEW.workspace_id AND id=NEW.consumed_event_id;
    IF NOT FOUND OR consumed_event.company_id IS DISTINCT FROM NEW.company_id OR
       consumed_event.customer_id IS DISTINCT FROM NEW.customer_id OR
       consumed_event.kind<>'redeem' OR consumed_event.points<>-NEW.points OR
       consumed_event.program_version IS DISTINCT FROM NEW.program_version OR
       consumed_event.source_order_id IS DISTINCT FROM NEW.source_order_id OR
       consumed_event.campaign_id IS DISTINCT FROM NEW.campaign_id OR
       consumed_event.campaign_version IS DISTINCT FROM NEW.campaign_version OR
       consumed_event.promotion_id IS DISTINCT FROM NEW.promotion_id OR
       consumed_event.promotion_version IS DISTINCT FROM NEW.promotion_version THEN
      RAISE EXCEPTION 'loyalty_reservation_consumed_event_changed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loyalty_point_reservation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON myfin.loyalty_point_reservations
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_loyalty_point_reservation();
CREATE TRIGGER no_truncate_loyalty_point_reservations
  BEFORE TRUNCATE ON myfin.loyalty_point_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_loyalty_history();

-- Runtime writes the account counter and reservation lifecycle row in one
-- transaction. Validate their aggregate at commit so either direct mutation
-- on its own fails, while the legitimate two-step write can remain atomic.
CREATE FUNCTION myfin.enforce_loyalty_reserved_total() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  target_workspace text;
  target_customer text;
  account_reserved bigint;
  active_reserved bigint;
BEGIN
  target_workspace:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  target_customer:=CASE WHEN TG_OP='DELETE' THEN OLD.customer_id ELSE NEW.customer_id END;
  SELECT reserved_points INTO account_reserved
    FROM myfin.customer_loyalty_accounts
   WHERE workspace_id=target_workspace AND customer_id=target_customer;
  SELECT coalesce(sum(points) FILTER (WHERE state='active'),0) INTO active_reserved
    FROM myfin.loyalty_point_reservations
   WHERE workspace_id=target_workspace AND customer_id=target_customer;
  IF (account_reserved IS NULL AND active_reserved<>0) OR
     (account_reserved IS NOT NULL AND account_reserved<>active_reserved) THEN
    RAISE EXCEPTION 'loyalty_reserved_total_changed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER loyalty_reserved_total_from_account
  AFTER INSERT OR UPDATE OR DELETE ON myfin.customer_loyalty_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION myfin.enforce_loyalty_reserved_total();
CREATE CONSTRAINT TRIGGER loyalty_reserved_total_from_reservation
  AFTER INSERT OR UPDATE OR DELETE ON myfin.loyalty_point_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION myfin.enforce_loyalty_reserved_total();

CREATE TABLE myfin.loyalty_point_reservation_events (
  workspace_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  reservation_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('reserved','consumed','released','expired')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  actor_type text NOT NULL CHECK(actor_type IN ('system','staff','customer')),
  staff_actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  customer_actor_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,reservation_id)
    REFERENCES myfin.loyalty_point_reservations(workspace_id,id) ON DELETE RESTRICT,
  CHECK((actor_type='system' AND staff_actor_id IS NULL AND customer_actor_id IS NULL) OR
        (actor_type='staff' AND staff_actor_id IS NOT NULL AND customer_actor_id IS NULL) OR
        (actor_type='customer' AND staff_actor_id IS NULL AND customer_actor_id IS NOT NULL))
);
CREATE TRIGGER immutable_loyalty_point_reservation_events
  BEFORE UPDATE OR DELETE ON myfin.loyalty_point_reservation_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_loyalty_history();
CREATE TRIGGER no_truncate_loyalty_point_reservation_events
  BEFORE TRUNCATE ON myfin.loyalty_point_reservation_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_loyalty_history();

REVOKE ALL ON myfin.workspace_loyalty_setting_versions,myfin.loyalty_point_events,
  myfin.loyalty_sale_award_batches,myfin.loyalty_point_reservations,
  myfin.loyalty_point_reservation_events FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.validate_free_item_redemption() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_loyalty_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_loyalty_point_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_loyalty_point_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_loyalty_reserved_total() FROM PUBLIC;
