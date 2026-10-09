-- Online-order promotions are quoted briefly, then reserve capacity for the
-- lifetime of the unpaid order. Raw voucher codes never enter this schema.

ALTER TABLE myfin.pricing_snapshots
  ADD COLUMN tax_basis_points integer NOT NULL DEFAULT 0
    CHECK(tax_basis_points BETWEEN 0 AND 10000);

CREATE TABLE myfin.promotion_reservations (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  order_id text NOT NULL,
  promotion_id text NOT NULL,
  promotion_version bigint NOT NULL CHECK(promotion_version > 0),
  voucher_id text,
  voucher_version bigint,
  pricing_snapshot_id text NOT NULL,
  customer_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  discount_sen bigint NOT NULL CHECK(discount_sen BETWEEN 1 AND 9000000000000000),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','released','consumed')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  consumed_at timestamptz,
  release_reason text NOT NULL DEFAULT '' CHECK(length(release_reason) <= 80),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,order_id,promotion_id),
  UNIQUE(company_id,order_id,promotion_id),
  FOREIGN KEY(workspace_id,company_id)
    REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,order_id)
    REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,pricing_snapshot_id,promotion_id)
    REFERENCES myfin.pricing_snapshot_discounts(workspace_id,company_id,snapshot_id,promotion_id)
    ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,promotion_id,voucher_id,voucher_version)
    REFERENCES myfin.promotion_voucher_versions(workspace_id,company_id,promotion_id,voucher_id,version)
    ON DELETE RESTRICT,
  CHECK((voucher_id IS NULL)=(voucher_version IS NULL)),
  CHECK(expires_at > reserved_at),
  CHECK((state='active' AND released_at IS NULL AND consumed_at IS NULL)
     OR (state='released' AND released_at IS NOT NULL AND consumed_at IS NULL)
     OR (state='consumed' AND released_at IS NULL AND consumed_at IS NOT NULL))
);

CREATE INDEX promotion_reservations_global_active_idx
  ON myfin.promotion_reservations(workspace_id,company_id,promotion_id,expires_at)
  WHERE state='active';
CREATE INDEX promotion_reservations_customer_active_idx
  ON myfin.promotion_reservations(workspace_id,company_id,promotion_id,customer_id,expires_at)
  WHERE state='active' AND customer_id IS NOT NULL;
CREATE INDEX promotion_reservations_voucher_active_idx
  ON myfin.promotion_reservations(workspace_id,company_id,promotion_id,voucher_id,customer_id,expires_at)
  WHERE state='active' AND voucher_id IS NOT NULL;

CREATE TABLE myfin.promotion_reservation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  order_id text NOT NULL,
  promotion_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('reserved','extended','released','consumed')),
  from_state text CHECK(from_state IS NULL OR from_state IN ('active','released','consumed')),
  to_state text NOT NULL CHECK(to_state IN ('active','released','consumed')),
  expires_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK(length(reason) <= 80),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,company_id,order_id,promotion_id)
    REFERENCES myfin.promotion_reservations(workspace_id,company_id,order_id,promotion_id)
    ON DELETE RESTRICT
);
CREATE INDEX promotion_reservation_events_order_idx
  ON myfin.promotion_reservation_events(company_id,order_id,id);

CREATE FUNCTION myfin.protect_promotion_reservation_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'promotion_reservation_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_promotion_reservation_events
  BEFORE UPDATE OR DELETE ON myfin.promotion_reservation_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_reservation_event();
CREATE TRIGGER no_truncate_promotion_reservation_events
  BEFORE TRUNCATE ON myfin.promotion_reservation_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_reservation_event();

CREATE FUNCTION myfin.protect_promotion_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.company_id IS DISTINCT FROM OLD.company_id OR
     NEW.order_id IS DISTINCT FROM OLD.order_id OR
     NEW.promotion_id IS DISTINCT FROM OLD.promotion_id OR
     NEW.promotion_version IS DISTINCT FROM OLD.promotion_version OR
     NEW.voucher_id IS DISTINCT FROM OLD.voucher_id OR
     NEW.voucher_version IS DISTINCT FROM OLD.voucher_version OR
     NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id OR
     NEW.customer_id IS DISTINCT FROM OLD.customer_id OR
     NEW.discount_sen IS DISTINCT FROM OLD.discount_sen OR
     NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
    RAISE EXCEPTION 'promotion_reservation_identity_immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state<>'active' OR NEW.state NOT IN ('active','released','consumed') THEN
    RAISE EXCEPTION 'promotion_reservation_final' USING ERRCODE='23514';
  END IF;
  IF NEW.state='active' AND NEW.expires_at<OLD.expires_at THEN
    RAISE EXCEPTION 'promotion_reservation_expiry_cannot_shorten' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER promotion_reservation_guard
  BEFORE UPDATE OR DELETE ON myfin.promotion_reservations
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_reservation();
CREATE TRIGGER no_truncate_promotion_reservations
  BEFORE TRUNCATE ON myfin.promotion_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_reservation_event();

CREATE FUNCTION myfin.append_promotion_reservation_event(
  reservation myfin.promotion_reservations, event_action text,
  prior_state text, next_state text, event_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
BEGIN
  INSERT INTO myfin.promotion_reservation_events(
    workspace_id,company_id,order_id,promotion_id,action,from_state,to_state,expires_at,reason)
  VALUES(reservation.workspace_id,reservation.company_id,reservation.order_id,reservation.promotion_id,
    event_action,prior_state,next_state,reservation.expires_at,event_reason);
END $$;

CREATE FUNCTION myfin.reserve_order_promotions(
  requested_company text, requested_order text, requested_snapshot text, requested_expiry timestamptz
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE
  order_row myfin.customer_order_requests%ROWTYPE;
  snapshot_row myfin.pricing_snapshots%ROWTYPE;
  application myfin.pricing_snapshot_discounts%ROWTYPE;
  current_promotion myfin.promotions%ROWTYPE;
  rule myfin.promotion_versions%ROWTYPE;
  current_voucher myfin.promotion_vouchers%ROWTYPE;
  voucher_rule myfin.promotion_voucher_versions%ROWTYPE;
  existing myfin.promotion_reservations%ROWTYPE;
  used bigint;
  held bigint;
  reservation myfin.promotion_reservations%ROWTYPE;
  reserved_count integer := 0;
BEGIN
  SELECT * INTO order_row FROM myfin.customer_order_requests
    WHERE company_id=requested_company AND id=requested_order FOR UPDATE;
  IF NOT FOUND OR order_row.pricing_snapshot_id IS DISTINCT FROM requested_snapshot OR
     order_row.status<>'awaiting_acceptance' OR order_row.payment_state<>'unpaid' OR
     order_row.expires_at IS DISTINCT FROM requested_expiry OR requested_expiry<=now() THEN
    RAISE EXCEPTION 'promotion_reservation_order_invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO snapshot_row FROM myfin.pricing_snapshots
    WHERE company_id=requested_company AND id=requested_snapshot FOR SHARE;
  IF NOT FOUND OR snapshot_row.customer_id IS DISTINCT FROM order_row.customer_id OR
     snapshot_row.expires_at IS NULL OR snapshot_row.expires_at<=now() THEN
    RAISE EXCEPTION 'promotion_reservation_snapshot_invalid' USING ERRCODE='23514';
  END IF;
  IF round(order_row.subtotal*100)::bigint<>snapshot_row.subtotal_sen OR
     round(order_row.discount_amount*100)::bigint<>snapshot_row.discount_sen OR
     round(order_row.tax*100)::bigint<>snapshot_row.tax_sen OR
     round(order_row.tax_rate*100)::integer<>snapshot_row.tax_basis_points OR
     round(order_row.total_before_rounding*100)::bigint<>
       snapshot_row.total_sen+order_row.delivery_fee_sen OR
     round(order_row.total*100)::bigint<>
       snapshot_row.total_sen+order_row.delivery_fee_sen+round(order_row.rounding*100)::bigint THEN
    RAISE EXCEPTION 'promotion_reservation_totals_changed' USING ERRCODE='23514';
  END IF;

  FOR application IN SELECT * FROM myfin.pricing_snapshot_discounts
    WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
      AND snapshot_id=requested_snapshot ORDER BY promotion_id
  LOOP
    SELECT * INTO existing FROM myfin.promotion_reservations
      WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
        AND order_id=requested_order AND promotion_id=application.promotion_id FOR UPDATE;
    IF FOUND THEN
      IF existing.pricing_snapshot_id<>requested_snapshot OR
         existing.promotion_version<>application.promotion_version OR
         existing.voucher_id IS DISTINCT FROM application.voucher_id OR
         existing.voucher_version IS DISTINCT FROM application.voucher_version OR
         existing.discount_sen<>application.discount_sen OR existing.state<>'active' OR
         existing.expires_at IS DISTINCT FROM requested_expiry OR existing.expires_at<=now() THEN
        RAISE EXCEPTION 'promotion_reservation_changed' USING ERRCODE='23514';
      END IF;
      reserved_count := reserved_count+1;
      CONTINUE;
    END IF;

    SELECT * INTO current_promotion FROM myfin.promotions
      WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
        AND id=application.promotion_id FOR UPDATE;
    IF NOT FOUND OR current_promotion.version<>application.promotion_version THEN
      RAISE EXCEPTION 'promotion_unavailable' USING ERRCODE='23514';
    END IF;
    SELECT * INTO STRICT rule FROM myfin.promotion_versions
      WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
        AND promotion_id=application.promotion_id AND version=application.promotion_version;
    IF NOT rule.enabled OR now()<rule.valid_from OR
       (rule.valid_until IS NOT NULL AND now()>=rule.valid_until) OR
       snapshot_row.currency_code<>rule.currency_code OR
       snapshot_row.subtotal_sen<rule.min_subtotal_sen THEN
      RAISE EXCEPTION 'promotion_unavailable' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(redemption_count,0) INTO used FROM myfin.promotion_usage_counters
      WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
        AND promotion_id=application.promotion_id;
    SELECT count(*) INTO held FROM myfin.promotion_reservations
      WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
        AND promotion_id=application.promotion_id AND state='active' AND expires_at>now();
    IF rule.max_total_redemptions IS NOT NULL AND coalesce(used,0)+held>=rule.max_total_redemptions THEN
      RAISE EXCEPTION 'promotion_usage_limit' USING ERRCODE='23514';
    END IF;
    IF rule.per_customer_limit IS NOT NULL AND snapshot_row.customer_id IS NULL THEN
      RAISE EXCEPTION 'promotion_customer_required' USING ERRCODE='23514';
    END IF;
    IF snapshot_row.customer_id IS NOT NULL THEN
      SELECT coalesce(redemption_count,0) INTO used FROM myfin.promotion_customer_usage_counters
        WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
          AND promotion_id=application.promotion_id AND customer_id=snapshot_row.customer_id;
      SELECT count(*) INTO held FROM myfin.promotion_reservations
        WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
          AND promotion_id=application.promotion_id AND customer_id=snapshot_row.customer_id
          AND state='active' AND expires_at>now();
      IF rule.per_customer_limit IS NOT NULL AND coalesce(used,0)+held>=rule.per_customer_limit THEN
        RAISE EXCEPTION 'promotion_customer_usage_limit' USING ERRCODE='23514';
      END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM myfin.promotion_version_customers target
      WHERE target.workspace_id=snapshot_row.workspace_id AND target.company_id=requested_company
        AND target.promotion_id=application.promotion_id
        AND target.promotion_version=application.promotion_version)
      AND NOT EXISTS(SELECT 1 FROM myfin.promotion_version_customers target
      WHERE target.workspace_id=snapshot_row.workspace_id AND target.company_id=requested_company
        AND target.promotion_id=application.promotion_id
        AND target.promotion_version=application.promotion_version
        AND target.customer_id=snapshot_row.customer_id) THEN
      RAISE EXCEPTION 'promotion_customer_ineligible' USING ERRCODE='23514';
    END IF;

    IF application.voucher_id IS NOT NULL THEN
      SELECT * INTO current_voucher FROM myfin.promotion_vouchers
        WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
          AND promotion_id=application.promotion_id AND id=application.voucher_id FOR UPDATE;
      IF NOT FOUND OR current_voucher.version<>application.voucher_version THEN
        RAISE EXCEPTION 'voucher_unavailable' USING ERRCODE='23514';
      END IF;
      SELECT * INTO STRICT voucher_rule FROM myfin.promotion_voucher_versions
        WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
          AND promotion_id=application.promotion_id AND voucher_id=application.voucher_id
          AND version=application.voucher_version;
      IF NOT voucher_rule.enabled OR now()<voucher_rule.valid_from OR
         (voucher_rule.valid_until IS NOT NULL AND now()>=voucher_rule.valid_until) THEN
        RAISE EXCEPTION 'voucher_unavailable' USING ERRCODE='23514';
      END IF;
      SELECT coalesce(redemption_count,0) INTO used FROM myfin.promotion_voucher_usage_counters
        WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
          AND promotion_id=application.promotion_id AND voucher_id=application.voucher_id;
      SELECT count(*) INTO held FROM myfin.promotion_reservations
        WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
          AND promotion_id=application.promotion_id AND voucher_id=application.voucher_id
          AND state='active' AND expires_at>now();
      IF voucher_rule.max_redemptions IS NOT NULL AND coalesce(used,0)+held>=voucher_rule.max_redemptions THEN
        RAISE EXCEPTION 'voucher_usage_limit' USING ERRCODE='23514';
      END IF;
      IF voucher_rule.per_customer_limit IS NOT NULL AND snapshot_row.customer_id IS NULL THEN
        RAISE EXCEPTION 'voucher_customer_required' USING ERRCODE='23514';
      END IF;
      IF snapshot_row.customer_id IS NOT NULL THEN
        SELECT coalesce(redemption_count,0) INTO used FROM myfin.promotion_voucher_customer_usage_counters
          WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
            AND promotion_id=application.promotion_id AND voucher_id=application.voucher_id
            AND customer_id=snapshot_row.customer_id;
        SELECT count(*) INTO held FROM myfin.promotion_reservations
          WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
            AND promotion_id=application.promotion_id AND voucher_id=application.voucher_id
            AND customer_id=snapshot_row.customer_id AND state='active' AND expires_at>now();
        IF voucher_rule.per_customer_limit IS NOT NULL AND coalesce(used,0)+held>=voucher_rule.per_customer_limit THEN
          RAISE EXCEPTION 'voucher_customer_usage_limit' USING ERRCODE='23514';
        END IF;
      END IF;
    END IF;

    INSERT INTO myfin.promotion_reservations(
      workspace_id,company_id,order_id,promotion_id,promotion_version,voucher_id,voucher_version,
      pricing_snapshot_id,customer_id,discount_sen,expires_at)
    VALUES(snapshot_row.workspace_id,requested_company,requested_order,application.promotion_id,
      application.promotion_version,application.voucher_id,application.voucher_version,
      requested_snapshot,snapshot_row.customer_id,application.discount_sen,requested_expiry)
    RETURNING * INTO reservation;
    PERFORM myfin.append_promotion_reservation_event(reservation,'reserved',NULL,'active','order_submitted');
    reserved_count := reserved_count+1;
  END LOOP;
  RETURN reserved_count;
END $$;

CREATE FUNCTION myfin.extend_order_promotion_reservations(
  requested_company text, requested_order text, requested_expiry timestamptz
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE order_row myfin.customer_order_requests%ROWTYPE;
  reservation myfin.promotion_reservations%ROWTYPE; changed integer := 0;
BEGIN
  IF requested_expiry<=now() THEN
    RAISE EXCEPTION 'promotion_reservation_expiry_invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO order_row FROM myfin.customer_order_requests
    WHERE company_id=requested_company AND id=requested_order FOR SHARE;
  IF NOT FOUND OR order_row.status NOT IN ('accepted','preparing','ready') OR
     order_row.payment_state<>'unpaid' OR order_row.expires_at IS DISTINCT FROM requested_expiry THEN
    RAISE EXCEPTION 'promotion_reservation_order_invalid' USING ERRCODE='23514';
  END IF;
  FOR reservation IN SELECT * FROM myfin.promotion_reservations
    WHERE company_id=requested_company AND order_id=requested_order
    ORDER BY promotion_id FOR UPDATE
  LOOP
    IF reservation.state<>'active' OR reservation.expires_at<=now() THEN
      RAISE EXCEPTION 'promotion_reservation_unavailable' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM myfin.promotions WHERE workspace_id=reservation.workspace_id
      AND company_id=reservation.company_id AND id=reservation.promotion_id FOR UPDATE;
    IF requested_expiry>reservation.expires_at THEN
      UPDATE myfin.promotion_reservations SET expires_at=requested_expiry,updated_at=now()
        WHERE workspace_id=reservation.workspace_id AND company_id=reservation.company_id
          AND order_id=reservation.order_id AND promotion_id=reservation.promotion_id
        RETURNING * INTO reservation;
      PERFORM myfin.append_promotion_reservation_event(reservation,'extended','active','active','order_extended');
    END IF;
    changed := changed+1;
  END LOOP;
  RETURN changed;
END $$;

CREATE FUNCTION myfin.release_order_promotion_reservations(
  requested_company text, requested_order text, requested_reason text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE order_row myfin.customer_order_requests%ROWTYPE;
  reservation myfin.promotion_reservations%ROWTYPE; changed integer := 0;
BEGIN
  IF requested_reason NOT IN ('cancelled','expired') THEN
    RAISE EXCEPTION 'promotion_reservation_release_reason_invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO order_row FROM myfin.customer_order_requests
    WHERE company_id=requested_company AND id=requested_order FOR SHARE;
  IF NOT FOUND OR order_row.status<>requested_reason OR order_row.payment_state<>'unpaid' THEN
    RAISE EXCEPTION 'promotion_reservation_order_invalid' USING ERRCODE='23514';
  END IF;
  FOR reservation IN SELECT * FROM myfin.promotion_reservations
    WHERE company_id=requested_company AND order_id=requested_order AND state='active'
    ORDER BY promotion_id FOR UPDATE
  LOOP
    PERFORM 1 FROM myfin.promotions WHERE workspace_id=reservation.workspace_id
      AND company_id=reservation.company_id AND id=reservation.promotion_id FOR UPDATE;
    UPDATE myfin.promotion_reservations SET state='released',released_at=now(),
      release_reason=requested_reason,updated_at=now()
      WHERE workspace_id=reservation.workspace_id AND company_id=reservation.company_id
        AND order_id=reservation.order_id AND promotion_id=reservation.promotion_id
      RETURNING * INTO reservation;
    PERFORM myfin.append_promotion_reservation_event(reservation,'released','active','released',requested_reason);
    changed := changed+1;
  END LOOP;
  RETURN changed;
END $$;

CREATE FUNCTION myfin.apply_reserved_promotion_usage(reservation myfin.promotion_reservations)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
BEGIN
  INSERT INTO myfin.promotion_usage_counters AS total_usage(workspace_id,company_id,promotion_id,redemption_count)
  VALUES(reservation.workspace_id,reservation.company_id,reservation.promotion_id,1)
  ON CONFLICT(workspace_id,company_id,promotion_id) DO UPDATE SET
    redemption_count=total_usage.redemption_count+1,version=total_usage.version+1,updated_at=now();
  IF reservation.customer_id IS NOT NULL THEN
    INSERT INTO myfin.promotion_customer_usage_counters AS customer_usage(
      workspace_id,company_id,promotion_id,customer_id,redemption_count)
    VALUES(reservation.workspace_id,reservation.company_id,reservation.promotion_id,reservation.customer_id,1)
    ON CONFLICT(workspace_id,company_id,promotion_id,customer_id) DO UPDATE SET
      redemption_count=customer_usage.redemption_count+1,version=customer_usage.version+1,updated_at=now();
  END IF;
  IF reservation.voucher_id IS NOT NULL THEN
    INSERT INTO myfin.promotion_voucher_usage_counters AS voucher_usage(
      workspace_id,company_id,promotion_id,voucher_id,redemption_count)
    VALUES(reservation.workspace_id,reservation.company_id,reservation.promotion_id,reservation.voucher_id,1)
    ON CONFLICT(workspace_id,company_id,promotion_id,voucher_id) DO UPDATE SET
      redemption_count=voucher_usage.redemption_count+1,version=voucher_usage.version+1,updated_at=now();
    IF reservation.customer_id IS NOT NULL THEN
      INSERT INTO myfin.promotion_voucher_customer_usage_counters AS voucher_customer_usage(
        workspace_id,company_id,promotion_id,voucher_id,customer_id,redemption_count)
      VALUES(reservation.workspace_id,reservation.company_id,reservation.promotion_id,reservation.voucher_id,
        reservation.customer_id,1)
      ON CONFLICT(workspace_id,company_id,promotion_id,voucher_id,customer_id) DO UPDATE SET
        redemption_count=voucher_customer_usage.redemption_count+1,
        version=voucher_customer_usage.version+1,updated_at=now();
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION myfin.enforce_promotion_redemption() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE
  current_promotion myfin.promotions%ROWTYPE;
  rule myfin.promotion_versions%ROWTYPE;
  current_voucher myfin.promotion_vouchers%ROWTYPE;
  voucher_rule myfin.promotion_voucher_versions%ROWTYPE;
  snapshot myfin.pricing_snapshots%ROWTYPE;
  reservation myfin.promotion_reservations%ROWTYPE;
  reserved_order myfin.customer_order_requests%ROWTYPE;
BEGIN
  -- An accepted online order reserved capacity while the rule and voucher were
  -- current. Consumption may happen after the short quote expires or an owner
  -- publishes a later version, but only for the exact paid source and evidence.
  IF NEW.source_type='customer_order' THEN
    SELECT * INTO reservation FROM myfin.promotion_reservations r
      WHERE r.workspace_id=NEW.workspace_id AND r.company_id=NEW.company_id
        AND r.order_id=NEW.source_id AND r.promotion_id=NEW.promotion_id
        AND r.promotion_version=NEW.promotion_version
        AND r.voucher_id IS NOT DISTINCT FROM NEW.voucher_id
        AND r.voucher_version IS NOT DISTINCT FROM NEW.voucher_version
        AND r.pricing_snapshot_id=NEW.pricing_snapshot_id
        AND r.customer_id IS NOT DISTINCT FROM NEW.customer_id
        AND r.discount_sen=NEW.discount_sen AND r.state='active'
      FOR UPDATE;
    IF FOUND THEN
      IF NEW.occurred_at>=reservation.expires_at THEN
        RAISE EXCEPTION 'promotion_reservation_expired' USING ERRCODE='23514';
      END IF;
      PERFORM 1 FROM myfin.promotions p
        WHERE p.workspace_id=NEW.workspace_id AND p.company_id=NEW.company_id
          AND p.id=NEW.promotion_id FOR UPDATE;
      IF NEW.voucher_id IS NOT NULL THEN
        PERFORM 1 FROM myfin.promotion_vouchers v
          WHERE v.workspace_id=NEW.workspace_id AND v.company_id=NEW.company_id
            AND v.promotion_id=NEW.promotion_id AND v.id=NEW.voucher_id FOR UPDATE;
      END IF;
      SELECT * INTO reserved_order FROM myfin.customer_order_requests o
        WHERE o.company_id=NEW.company_id AND o.id=NEW.source_id FOR SHARE;
      IF NOT FOUND OR reserved_order.status<>'paid' OR reserved_order.payment_state<>'paid' OR
         reserved_order.pricing_snapshot_id<>NEW.pricing_snapshot_id OR
         reserved_order.customer_id IS DISTINCT FROM NEW.customer_id OR NOT EXISTS(
        SELECT 1 FROM myfin.customer_order_payments payment
        JOIN myfin.transactions sale ON sale.company_id=payment.company_id AND sale.id=payment.sale_id
        WHERE payment.company_id=NEW.company_id AND payment.order_id=NEW.source_id
          AND sale.source='pos' AND sale.pricing_snapshot_id=NEW.pricing_snapshot_id
      ) THEN
        RAISE EXCEPTION 'promotion_reserved_source_invalid' USING ERRCODE='23514';
      END IF;
      PERFORM myfin.apply_reserved_promotion_usage(reservation);
      RETURN NEW;
    END IF;
  END IF;
  SELECT * INTO current_promotion FROM myfin.promotions
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id AND id=NEW.promotion_id
    FOR UPDATE;
  IF NOT FOUND OR current_promotion.version<>NEW.promotion_version THEN
    RAISE EXCEPTION 'promotion_changed' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT rule FROM myfin.promotion_versions
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
      AND promotion_id=NEW.promotion_id AND version=NEW.promotion_version;
  IF NOT rule.enabled OR NEW.occurred_at<rule.valid_from OR
     (rule.valid_until IS NOT NULL AND NEW.occurred_at>=rule.valid_until) THEN
    RAISE EXCEPTION 'promotion_unavailable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT snapshot FROM myfin.pricing_snapshots
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id AND id=NEW.pricing_snapshot_id;
  IF snapshot.customer_id IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'promotion_customer_changed' USING ERRCODE='23514';
  END IF;
  IF rule.requires_customer AND NEW.customer_id IS NULL THEN
    RAISE EXCEPTION 'promotion_customer_required' USING ERRCODE='23514';
  END IF;
  IF rule.requires_student AND snapshot.student_eligibility_version IS NULL THEN
    RAISE EXCEPTION 'student_eligibility_required' USING ERRCODE='23514';
  END IF;
  IF rule.requires_student AND NOT EXISTS(
    SELECT 1 FROM myfin.student_eligibility_events e
    WHERE e.workspace_id=NEW.workspace_id AND e.customer_id=NEW.customer_id
      AND e.version=snapshot.student_eligibility_version AND e.to_status='verified'
      AND snapshot.priced_at>=e.valid_from AND snapshot.priced_at<e.valid_until
  ) THEN
    RAISE EXCEPTION 'student_eligibility_expired' USING ERRCODE='23514';
  END IF;
  IF snapshot.expires_at IS NOT NULL AND NEW.occurred_at>=snapshot.expires_at THEN
    RAISE EXCEPTION 'pricing_snapshot_expired' USING ERRCODE='23514';
  END IF;
  IF snapshot.currency_code<>rule.currency_code OR snapshot.subtotal_sen<rule.min_subtotal_sen THEN
    RAISE EXCEPTION 'pricing_snapshot_rule_changed' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM myfin.promotion_version_customers pc
    WHERE pc.workspace_id=NEW.workspace_id AND pc.company_id=NEW.company_id
      AND pc.promotion_id=NEW.promotion_id AND pc.promotion_version=NEW.promotion_version
  ) AND NOT EXISTS(
    SELECT 1 FROM myfin.promotion_version_customers pc
    WHERE pc.workspace_id=NEW.workspace_id AND pc.company_id=NEW.company_id
      AND pc.promotion_id=NEW.promotion_id AND pc.promotion_version=NEW.promotion_version
      AND pc.customer_id=NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'promotion_customer_ineligible' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM myfin.pricing_snapshot_discounts d
    WHERE d.workspace_id=NEW.workspace_id AND d.company_id=NEW.company_id
      AND d.snapshot_id=NEW.pricing_snapshot_id AND d.promotion_id=NEW.promotion_id
      AND d.promotion_version=NEW.promotion_version
      AND d.voucher_id IS NOT DISTINCT FROM NEW.voucher_id
      AND d.voucher_version IS NOT DISTINCT FROM NEW.voucher_version
      AND d.discount_sen=NEW.discount_sen
  ) THEN
    RAISE EXCEPTION 'pricing_snapshot_discount_changed' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM myfin.pricing_snapshot_discount_lines dl
    JOIN myfin.pricing_snapshot_discounts d
      ON d.workspace_id=dl.workspace_id AND d.company_id=dl.company_id
      AND d.snapshot_id=dl.snapshot_id AND d.sequence=dl.discount_sequence
    JOIN myfin.pricing_snapshot_lines l
      ON l.workspace_id=dl.workspace_id AND l.company_id=dl.company_id
      AND l.snapshot_id=dl.snapshot_id AND l.line_no=dl.line_no
    WHERE d.workspace_id=NEW.workspace_id AND d.company_id=NEW.company_id
      AND d.snapshot_id=NEW.pricing_snapshot_id AND d.promotion_id=NEW.promotion_id
      AND (EXISTS(
        SELECT 1 FROM myfin.promotion_version_products pp
        WHERE pp.workspace_id=NEW.workspace_id AND pp.company_id=NEW.company_id
          AND pp.promotion_id=NEW.promotion_id AND pp.promotion_version=NEW.promotion_version
      ) OR EXISTS(
        SELECT 1 FROM myfin.promotion_version_categories pc
        WHERE pc.workspace_id=NEW.workspace_id AND pc.company_id=NEW.company_id
          AND pc.promotion_id=NEW.promotion_id AND pc.promotion_version=NEW.promotion_version
      ))
      AND NOT (
        EXISTS(SELECT 1 FROM myfin.promotion_version_products pp
          WHERE pp.workspace_id=NEW.workspace_id AND pp.company_id=NEW.company_id
            AND pp.promotion_id=NEW.promotion_id AND pp.promotion_version=NEW.promotion_version
            AND pp.product_id=l.product_id AND (pp.variant_id IS NULL OR pp.variant_id=l.variant_id))
        OR EXISTS(SELECT 1 FROM myfin.promotion_version_categories pc
          WHERE pc.workspace_id=NEW.workspace_id AND pc.company_id=NEW.company_id
            AND pc.promotion_id=NEW.promotion_id AND pc.promotion_version=NEW.promotion_version
            AND pc.category_key=lower(btrim(l.category))
            AND (pc.subcategory_key='' OR pc.subcategory_key=lower(btrim(l.subcategory))))
      )
  ) THEN
    RAISE EXCEPTION 'promotion_product_ineligible' USING ERRCODE='23514';
  END IF;
  IF ((rule.redemption_mode='voucher' AND NEW.voucher_id IS NULL) OR
      (rule.redemption_mode='automatic' AND NEW.voucher_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'promotion_redemption_mode_changed' USING ERRCODE='23514';
  END IF;
  INSERT INTO myfin.promotion_usage_counters AS usage_total(workspace_id,company_id,promotion_id,redemption_count)
    VALUES(NEW.workspace_id,NEW.company_id,NEW.promotion_id,1)
    ON CONFLICT(workspace_id,company_id,promotion_id) DO UPDATE SET
      redemption_count=usage_total.redemption_count+1,
      version=usage_total.version+1,updated_at=now()
      WHERE rule.max_total_redemptions IS NULL OR
        usage_total.redemption_count<rule.max_total_redemptions;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promotion_usage_limit' USING ERRCODE='23514';
  END IF;
  IF rule.per_customer_limit IS NOT NULL AND NEW.customer_id IS NULL THEN
    RAISE EXCEPTION 'promotion_customer_required' USING ERRCODE='23514';
  END IF;
  IF NEW.customer_id IS NOT NULL THEN
    INSERT INTO myfin.promotion_customer_usage_counters AS customer_usage(
      workspace_id,company_id,promotion_id,customer_id,redemption_count)
      VALUES(NEW.workspace_id,NEW.company_id,NEW.promotion_id,NEW.customer_id,1)
      ON CONFLICT(workspace_id,company_id,promotion_id,customer_id) DO UPDATE SET
        redemption_count=customer_usage.redemption_count+1,
        version=customer_usage.version+1,updated_at=now()
        WHERE rule.per_customer_limit IS NULL OR
          customer_usage.redemption_count<rule.per_customer_limit;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'promotion_customer_usage_limit' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.voucher_id IS NOT NULL THEN
    SELECT * INTO current_voucher FROM myfin.promotion_vouchers
      WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
        AND promotion_id=NEW.promotion_id AND id=NEW.voucher_id FOR UPDATE;
    IF NOT FOUND OR current_voucher.version<>NEW.voucher_version THEN
      RAISE EXCEPTION 'voucher_changed' USING ERRCODE='23514';
    END IF;
    SELECT * INTO STRICT voucher_rule FROM myfin.promotion_voucher_versions
      WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
        AND promotion_id=NEW.promotion_id AND voucher_id=NEW.voucher_id AND version=NEW.voucher_version;
    IF NOT voucher_rule.enabled OR NEW.occurred_at<voucher_rule.valid_from OR
       (voucher_rule.valid_until IS NOT NULL AND NEW.occurred_at>=voucher_rule.valid_until) THEN
      RAISE EXCEPTION 'voucher_unavailable' USING ERRCODE='23514';
    END IF;
    INSERT INTO myfin.promotion_voucher_usage_counters AS voucher_usage(
      workspace_id,company_id,promotion_id,voucher_id,redemption_count)
      VALUES(NEW.workspace_id,NEW.company_id,NEW.promotion_id,NEW.voucher_id,1)
      ON CONFLICT(workspace_id,company_id,promotion_id,voucher_id) DO UPDATE SET
        redemption_count=voucher_usage.redemption_count+1,
        version=voucher_usage.version+1,updated_at=now()
        WHERE voucher_rule.max_redemptions IS NULL OR
          voucher_usage.redemption_count<voucher_rule.max_redemptions;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'voucher_usage_limit' USING ERRCODE='23514';
    END IF;
    IF voucher_rule.per_customer_limit IS NOT NULL AND NEW.customer_id IS NULL THEN
      RAISE EXCEPTION 'voucher_customer_required' USING ERRCODE='23514';
    END IF;
    IF NEW.customer_id IS NOT NULL THEN
      INSERT INTO myfin.promotion_voucher_customer_usage_counters AS voucher_customer_usage(
        workspace_id,company_id,promotion_id,voucher_id,customer_id,redemption_count)
        VALUES(NEW.workspace_id,NEW.company_id,NEW.promotion_id,NEW.voucher_id,NEW.customer_id,1)
        ON CONFLICT(workspace_id,company_id,promotion_id,voucher_id,customer_id) DO UPDATE SET
          redemption_count=voucher_customer_usage.redemption_count+1,
          version=voucher_customer_usage.version+1,updated_at=now()
          WHERE voucher_rule.per_customer_limit IS NULL OR
            voucher_customer_usage.redemption_count<voucher_rule.per_customer_limit;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'voucher_customer_usage_limit' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION myfin.consume_order_promotion_reservations(
  requested_company text, requested_order text, requested_sale text, occurred_at timestamptz
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE
  reservation myfin.promotion_reservations%ROWTYPE;
  redemption_id text;
  changed integer := 0;
BEGIN
  FOR reservation IN SELECT * FROM myfin.promotion_reservations
    WHERE company_id=requested_company AND order_id=requested_order
    ORDER BY promotion_id FOR UPDATE
  LOOP
    IF NOT EXISTS(
      SELECT 1 FROM myfin.customer_order_requests order_row
      JOIN myfin.customer_order_payments payment
        ON payment.company_id=order_row.company_id AND payment.order_id=order_row.id
      JOIN myfin.transactions sale
        ON sale.company_id=payment.company_id AND sale.id=payment.sale_id
      WHERE order_row.company_id=requested_company AND order_row.id=requested_order
        AND order_row.status='paid' AND order_row.payment_state='paid'
        AND payment.sale_id=requested_sale AND sale.source='pos'
        AND order_row.pricing_snapshot_id=reservation.pricing_snapshot_id
        AND sale.pricing_snapshot_id=reservation.pricing_snapshot_id
    ) THEN
      RAISE EXCEPTION 'promotion_reserved_source_invalid' USING ERRCODE='23514';
    END IF;
    IF reservation.state='consumed' THEN
      IF NOT EXISTS(SELECT 1 FROM myfin.promotion_redemptions r
        WHERE r.company_id=requested_company AND r.source_type='customer_order'
          AND r.source_id=requested_order AND r.promotion_id=reservation.promotion_id
          AND r.pricing_snapshot_id=reservation.pricing_snapshot_id) THEN
        RAISE EXCEPTION 'promotion_consumption_incomplete' USING ERRCODE='23514';
      END IF;
      changed := changed+1;
      CONTINUE;
    END IF;
    IF reservation.state<>'active' OR occurred_at>=reservation.expires_at THEN
      RAISE EXCEPTION 'promotion_reservation_unavailable' USING ERRCODE='23514';
    END IF;
    redemption_id := 'reserved-'||md5(requested_company||':'||requested_order||':'||reservation.promotion_id);
    INSERT INTO myfin.promotion_redemptions(
      workspace_id,company_id,id,promotion_id,promotion_version,voucher_id,voucher_version,
      pricing_snapshot_id,customer_id,source_type,source_id,idempotency_key,request_digest,
      discount_sen,occurred_at)
    VALUES(reservation.workspace_id,reservation.company_id,redemption_id,reservation.promotion_id,
      reservation.promotion_version,reservation.voucher_id,reservation.voucher_version,
      reservation.pricing_snapshot_id,reservation.customer_id,'customer_order',requested_order,
      md5(requested_company||':customer_order:'||requested_order||':'||reservation.promotion_id),
      md5(reservation.pricing_snapshot_id||':'||requested_sale)||
        md5(requested_order||':'||reservation.promotion_id||':'||reservation.discount_sen::text),
      reservation.discount_sen,occurred_at);
    UPDATE myfin.promotion_reservations SET state='consumed',consumed_at=occurred_at,updated_at=now()
      WHERE workspace_id=reservation.workspace_id AND company_id=reservation.company_id
        AND order_id=reservation.order_id AND promotion_id=reservation.promotion_id
      RETURNING * INTO reservation;
    PERFORM myfin.append_promotion_reservation_event(reservation,'consumed','active','consumed','paid');
    changed := changed+1;
  END LOOP;
  RETURN changed;
END $$;

REVOKE ALL ON myfin.promotion_reservations FROM PUBLIC;
REVOKE ALL ON myfin.promotion_reservation_events FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_promotion_reservation_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_promotion_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.append_promotion_reservation_event(myfin.promotion_reservations,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.reserve_order_promotions(text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.extend_order_promotion_reservations(text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.release_order_promotion_reservations(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.apply_reserved_promotion_usage(myfin.promotion_reservations) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.consume_order_promotion_reservations(text,text,text,timestamptz) FROM PUBLIC;

COMMENT ON TABLE myfin.promotion_reservations IS
  'Capacity reserved by an unpaid online order. Voucher codes are never stored; only immutable voucher-version references are retained.';
COMMENT ON TABLE myfin.promotion_reservation_events IS
  'Immutable audit history for reservation, extension, release and consumption.';
