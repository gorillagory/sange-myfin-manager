-- Bind staff POS quotes to their pricing channel and issuing identity. Promotion
-- and discretionary discounts remain separately attributable while every
-- persisted total and line continues to be checked at transaction commit.

ALTER TABLE myfin.pricing_snapshots
  ADD COLUMN channel text NOT NULL DEFAULT 'storefront'
    CHECK(channel IN ('storefront','pos')),
  ADD COLUMN issued_to_staff_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  ADD COLUMN manual_discount_basis_points integer NOT NULL DEFAULT 0
    CHECK(manual_discount_basis_points BETWEEN 0 AND 10000),
  ADD COLUMN manual_discount_sen bigint NOT NULL DEFAULT 0
    CHECK(manual_discount_sen BETWEEN 0 AND 9000000000000000),
  ADD COLUMN recovery_expires_at timestamptz,
  ADD COLUMN promotion_discount_sen bigint
    GENERATED ALWAYS AS (discount_sen-manual_discount_sen) STORED
    CHECK(promotion_discount_sen BETWEEN 0 AND 9000000000000000),
  ADD CONSTRAINT pricing_snapshot_channel_principal_check
    CHECK((channel='pos')=(issued_to_staff_id IS NOT NULL)),
  ADD CONSTRAINT pricing_snapshot_manual_channel_check
    CHECK(channel='pos' OR (manual_discount_basis_points=0 AND manual_discount_sen=0)),
  ADD CONSTRAINT pricing_snapshot_manual_discount_check
    CHECK(manual_discount_basis_points<>0 OR manual_discount_sen=0),
  ADD CONSTRAINT pricing_snapshot_recovery_window_check CHECK(
    (channel='storefront' AND recovery_expires_at IS NULL) OR
    (channel='pos' AND expires_at IS NOT NULL AND recovery_expires_at>expires_at
      AND recovery_expires_at<=priced_at+interval '15 minutes')
  );

CREATE INDEX pricing_snapshots_pos_principal_idx
  ON myfin.pricing_snapshots(company_id,issued_to_staff_id,expires_at,id)
  WHERE channel='pos';

ALTER TABLE myfin.pricing_snapshot_lines
  ADD COLUMN automatic_reward boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN myfin.pricing_snapshot_lines.automatic_reward IS
  'True when POS pricing inserted this immutable reward line for an eligible free-item campaign.';

CREATE OR REPLACE FUNCTION myfin.require_pricing_snapshot_details() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  line_gross bigint;
  line_discount bigint;
  line_net bigint;
  application_discount bigint;
BEGIN
  SELECT coalesce(sum(gross_sen),0),coalesce(sum(discount_sen),0),coalesce(sum(net_sen),0)
    INTO line_gross,line_discount,line_net
    FROM myfin.pricing_snapshot_lines
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id AND snapshot_id=NEW.id;
  SELECT coalesce(sum(discount_sen),0) INTO application_discount
    FROM myfin.pricing_snapshot_discounts
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id AND snapshot_id=NEW.id;
  IF line_gross<>NEW.subtotal_sen OR line_discount<>NEW.discount_sen OR
     line_net<>NEW.taxable_sen OR application_discount<>NEW.promotion_discount_sen THEN
    RAISE EXCEPTION 'pricing_snapshot_details_required' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM myfin.pricing_snapshot_discounts d
    WHERE d.workspace_id=NEW.workspace_id AND d.company_id=NEW.company_id AND d.snapshot_id=NEW.id
      AND d.discount_sen<>(SELECT coalesce(sum(dl.discount_sen),0)
        FROM myfin.pricing_snapshot_discount_lines dl
        WHERE dl.workspace_id=d.workspace_id AND dl.company_id=d.company_id
          AND dl.snapshot_id=d.snapshot_id AND dl.discount_sequence=d.sequence)
  ) THEN
    RAISE EXCEPTION 'pricing_snapshot_discount_lines_required' USING ERRCODE='23514';
  END IF;
  IF NEW.student_eligibility_version IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM myfin.student_eligibility_events e
    WHERE e.workspace_id=NEW.workspace_id AND e.customer_id=NEW.customer_id
      AND e.version=NEW.student_eligibility_version AND e.to_status='verified'
      AND NEW.priced_at>=e.valid_from AND NEW.priced_at<e.valid_until
  ) THEN
    RAISE EXCEPTION 'pricing_snapshot_student_eligibility_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

-- A POS free-item reward may span an existing partial basket line plus an
-- automatically inserted remainder line. Revalidate the exact aggregate
-- rewarded quantity and each line's payable value rather than requiring one
-- discount line. Earlier stacked free-item applications reduce the quantity
-- still available on a line just as the server pricing engine does.
CREATE OR REPLACE FUNCTION myfin.validate_free_item_redemption() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  rule myfin.promotion_versions%ROWTYPE;
  target_sequence integer;
  reward_line record;
  prior_rule record;
  prior_line record;
  remaining_quantities bigint[] := ARRAY[]::bigint[];
  quantity_left bigint;
  prior_quantity_left bigint;
  available_quantity bigint;
  allocated_quantity bigint;
  line_remaining bigint;
  calculated_line_discount bigint;
  expected_discount bigint := 0;
  reward_line_count integer := 0;
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

  FOR reward_line IN
    SELECT line_no,quantity_milli FROM myfin.pricing_snapshot_lines
     WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
       AND snapshot_id=NEW.pricing_snapshot_id ORDER BY line_no
  LOOP
    remaining_quantities[reward_line.line_no] := reward_line.quantity_milli;
  END LOOP;

  FOR prior_rule IN
    SELECT discount_row.sequence,version_row.reward_quantity_milli
      FROM myfin.pricing_snapshot_discounts discount_row
      JOIN myfin.promotion_versions version_row
        ON version_row.workspace_id=discount_row.workspace_id
       AND version_row.company_id=discount_row.company_id
       AND version_row.promotion_id=discount_row.promotion_id
       AND version_row.version=discount_row.promotion_version
     WHERE discount_row.workspace_id=NEW.workspace_id
       AND discount_row.company_id=NEW.company_id
       AND discount_row.snapshot_id=NEW.pricing_snapshot_id
       AND discount_row.sequence<target_sequence
       AND version_row.discount_type='free_item'
     ORDER BY discount_row.sequence
  LOOP
    prior_quantity_left := prior_rule.reward_quantity_milli;
    FOR prior_line IN
      SELECT line_no FROM myfin.pricing_snapshot_discount_lines
       WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
         AND snapshot_id=NEW.pricing_snapshot_id
         AND discount_sequence=prior_rule.sequence
       ORDER BY line_no
    LOOP
      available_quantity := coalesce(remaining_quantities[prior_line.line_no],0);
      allocated_quantity := least(available_quantity,prior_quantity_left);
      remaining_quantities[prior_line.line_no] := available_quantity-allocated_quantity;
      prior_quantity_left := prior_quantity_left-allocated_quantity;
      EXIT WHEN prior_quantity_left=0;
    END LOOP;
  END LOOP;

  quantity_left := rule.reward_quantity_milli;
  FOR reward_line IN
    SELECT l.line_no,l.product_id,l.variant_id,l.gross_sen,
           dl.discount_sen AS applied_discount_sen,
           coalesce((SELECT sum(prior.discount_sen)
             FROM myfin.pricing_snapshot_discount_lines prior
             WHERE prior.workspace_id=l.workspace_id AND prior.company_id=l.company_id
               AND prior.snapshot_id=l.snapshot_id AND prior.line_no=l.line_no
               AND prior.discount_sequence<target_sequence),0)::bigint AS prior_discount_sen
      FROM myfin.pricing_snapshot_discount_lines dl
      JOIN myfin.pricing_snapshot_lines l
        ON l.workspace_id=dl.workspace_id AND l.company_id=dl.company_id
       AND l.snapshot_id=dl.snapshot_id AND l.line_no=dl.line_no
     WHERE dl.workspace_id=NEW.workspace_id AND dl.company_id=NEW.company_id
       AND dl.snapshot_id=NEW.pricing_snapshot_id
       AND dl.discount_sequence=target_sequence
     ORDER BY l.line_no
  LOOP
    reward_line_count := reward_line_count+1;
    available_quantity := coalesce(remaining_quantities[reward_line.line_no],0);
    IF reward_line.product_id<>rule.reward_product_id OR
       reward_line.variant_id IS DISTINCT FROM rule.reward_variant_id OR
       available_quantity<=0 OR quantity_left<=0 THEN
      RAISE EXCEPTION 'free_item_pricing_changed' USING ERRCODE='23514';
    END IF;
    allocated_quantity := least(available_quantity,quantity_left);
    line_remaining := reward_line.gross_sen-reward_line.prior_discount_sen;
    calculated_line_discount := least(line_remaining,
      round((line_remaining::numeric*allocated_quantity::numeric)/available_quantity)::bigint);
    IF calculated_line_discount<=0 OR
       calculated_line_discount<>reward_line.applied_discount_sen THEN
      RAISE EXCEPTION 'free_item_pricing_changed' USING ERRCODE='23514';
    END IF;
    expected_discount := expected_discount+calculated_line_discount;
    quantity_left := quantity_left-allocated_quantity;
  END LOOP;

  IF reward_line_count=0 OR quantity_left<>0 OR expected_discount<>NEW.discount_sen THEN
    RAISE EXCEPTION 'free_item_pricing_changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON COLUMN myfin.pricing_snapshots.channel IS
  'Authoritative price surface. POS snapshots are bound to issued_to_staff_id.';
COMMENT ON COLUMN myfin.pricing_snapshots.manual_discount_sen IS
  'Discretionary staff discount, kept separate from campaign promotion redemptions.';
COMMENT ON COLUMN myfin.pricing_snapshots.recovery_expires_at IS
  'Bounded POS replay window. Customer-facing collection must still occur before expires_at.';

-- Loyalty awards originally assumed every paid sale came from an online-order
-- request. A registered customer may also buy directly at a staff POS, so the
-- immutable batch records the exact source kind while retaining the posted
-- transaction as the canonical monetary source.
ALTER TABLE myfin.loyalty_sale_award_batches
  ALTER COLUMN source_order_id DROP NOT NULL,
  ADD COLUMN source_type text NOT NULL DEFAULT 'customer_order'
    CHECK(source_type IN ('customer_order','pos_sale')),
  ADD CONSTRAINT loyalty_sale_award_batch_source_check
    CHECK((source_type='customer_order')=(source_order_id IS NOT NULL));

COMMENT ON COLUMN myfin.loyalty_sale_award_batches.source_type IS
  'Immutable award origin. Direct POS sales have no customer-order row and use pos_sale.';

-- A cashier must be able to rely on a locked price before collecting money.
-- POS holds share the existing reservation table so online orders and tills
-- compete against one serialized capacity ledger. The original order_id
-- foreign key cannot represent a not-yet-posted POS sale, so source integrity
-- is enforced by the guarded SECURITY DEFINER writers below.
ALTER TABLE myfin.promotion_reservations
  DROP CONSTRAINT promotion_reservations_company_id_order_id_fkey,
  ADD COLUMN source_type text NOT NULL DEFAULT 'customer_order'
    CHECK(source_type IN ('customer_order','pos_sale')),
  ADD COLUMN pos_checkout_id text,
  ADD CONSTRAINT promotion_reservation_source_shape_check CHECK(
    (source_type='customer_order' AND pos_checkout_id IS NULL) OR
    (source_type='pos_sale' AND pos_checkout_id IS NOT NULL AND length(pos_checkout_id) BETWEEN 1 AND 128)
  );

CREATE INDEX promotion_reservations_pos_checkout_idx
  ON myfin.promotion_reservations(company_id,pos_checkout_id,state,expires_at)
  WHERE source_type='pos_sale';

CREATE FUNCTION myfin.enforce_promotion_reservation_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE snapshot_row myfin.pricing_snapshots%ROWTYPE;
BEGIN
  IF NEW.source_type='customer_order' THEN
    IF NEW.pos_checkout_id IS NOT NULL OR NOT EXISTS(
      SELECT 1 FROM myfin.customer_order_requests request
       WHERE request.company_id=NEW.company_id AND request.id=NEW.order_id
    ) THEN
      RAISE EXCEPTION 'promotion_reservation_order_invalid' USING ERRCODE='23503';
    END IF;
  ELSE
    SELECT * INTO snapshot_row FROM myfin.pricing_snapshots snapshot
      WHERE snapshot.workspace_id=NEW.workspace_id AND snapshot.company_id=NEW.company_id
        AND snapshot.id=NEW.pricing_snapshot_id;
    IF NOT FOUND OR snapshot_row.channel<>'pos' OR
       NEW.order_id<>'pos:'||NEW.pricing_snapshot_id OR NEW.pos_checkout_id IS NULL THEN
      RAISE EXCEPTION 'promotion_reservation_pos_source_invalid' USING ERRCODE='23503';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER promotion_reservation_source_guard
  BEFORE INSERT OR UPDATE ON myfin.promotion_reservations
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_promotion_reservation_source();

CREATE FUNCTION myfin.restrict_reserved_customer_order_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM myfin.promotion_reservations reservation
     WHERE reservation.company_id=OLD.company_id AND reservation.order_id=OLD.id
       AND reservation.source_type='customer_order'
  ) THEN
    RAISE EXCEPTION 'promotion_reservation_order_referenced' USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER customer_order_promotion_reservation_delete_guard
  BEFORE DELETE ON myfin.customer_order_requests
  FOR EACH ROW EXECUTE FUNCTION myfin.restrict_reserved_customer_order_delete();

CREATE OR REPLACE FUNCTION myfin.protect_promotion_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.company_id IS DISTINCT FROM OLD.company_id OR
     NEW.order_id IS DISTINCT FROM OLD.order_id OR
     NEW.source_type IS DISTINCT FROM OLD.source_type OR
     NEW.pos_checkout_id IS DISTINCT FROM OLD.pos_checkout_id OR
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

CREATE FUNCTION myfin.reserve_pos_promotions(
  requested_company text, requested_checkout text, requested_snapshot text, requested_expiry timestamptz
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE
  snapshot_row myfin.pricing_snapshots%ROWTYPE;
  application myfin.pricing_snapshot_discounts%ROWTYPE;
  current_promotion myfin.promotions%ROWTYPE;
  rule myfin.promotion_versions%ROWTYPE;
  current_voucher myfin.promotion_vouchers%ROWTYPE;
  voucher_rule myfin.promotion_voucher_versions%ROWTYPE;
  reservation myfin.promotion_reservations%ROWTYPE;
  used bigint;
  held bigint;
  reserved_count integer := 0;
BEGIN
  IF requested_checkout IS NULL OR length(requested_checkout) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'promotion_reservation_checkout_invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO snapshot_row FROM myfin.pricing_snapshots
    WHERE company_id=requested_company AND id=requested_snapshot FOR SHARE;
  IF NOT FOUND OR snapshot_row.channel<>'pos' OR snapshot_row.issued_to_staff_id IS NULL OR
     snapshot_row.recovery_expires_at IS DISTINCT FROM requested_expiry OR
     requested_expiry<=snapshot_row.expires_at OR requested_expiry<=now() THEN
    RAISE EXCEPTION 'promotion_reservation_snapshot_invalid' USING ERRCODE='23514';
  END IF;

  -- Expired holds stop counting at the exact expiry instant. Their durable
  -- state is finalized lazily, while refreshing the same cart releases its
  -- prior still-live price before reserving the replacement snapshot.
  FOR reservation IN SELECT * FROM myfin.promotion_reservations
    WHERE company_id=requested_company AND source_type='pos_sale' AND state='active'
      AND (expires_at<=now() OR pos_checkout_id=requested_checkout)
    ORDER BY promotion_id,order_id FOR UPDATE
  LOOP
    PERFORM 1 FROM myfin.promotions promotion
      WHERE promotion.workspace_id=reservation.workspace_id
        AND promotion.company_id=reservation.company_id
        AND promotion.id=reservation.promotion_id FOR UPDATE;
    UPDATE myfin.promotion_reservations SET state='released',released_at=now(),
      release_reason=CASE WHEN expires_at<=now() THEN 'price_expired' ELSE 'price_refreshed' END,
      updated_at=now()
      WHERE workspace_id=reservation.workspace_id AND company_id=reservation.company_id
        AND order_id=reservation.order_id AND promotion_id=reservation.promotion_id
      RETURNING * INTO reservation;
    PERFORM myfin.append_promotion_reservation_event(reservation,'released','active','released',
      reservation.release_reason);
  END LOOP;

  FOR application IN SELECT * FROM myfin.pricing_snapshot_discounts
    WHERE workspace_id=snapshot_row.workspace_id AND company_id=requested_company
      AND snapshot_id=requested_snapshot ORDER BY promotion_id
  LOOP
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
      pricing_snapshot_id,customer_id,discount_sen,expires_at,source_type,pos_checkout_id)
    VALUES(snapshot_row.workspace_id,requested_company,'pos:'||requested_snapshot,
      application.promotion_id,application.promotion_version,application.voucher_id,
      application.voucher_version,requested_snapshot,snapshot_row.customer_id,
      application.discount_sen,requested_expiry,'pos_sale',requested_checkout)
    RETURNING * INTO reservation;
    PERFORM myfin.append_promotion_reservation_event(reservation,'reserved',NULL,'active','pos_price_locked');
    reserved_count := reserved_count+1;
  END LOOP;
  RETURN reserved_count;
END $$;

CREATE FUNCTION myfin.release_pos_promotions(
  requested_company text, requested_checkout text, requested_snapshot text, requested_staff text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE snapshot_row myfin.pricing_snapshots%ROWTYPE;
  reservation myfin.promotion_reservations%ROWTYPE; released_count integer := 0;
BEGIN
  SELECT * INTO snapshot_row FROM myfin.pricing_snapshots snapshot
    WHERE snapshot.company_id=requested_company AND snapshot.id=requested_snapshot FOR SHARE;
  IF NOT FOUND OR snapshot_row.channel<>'pos' OR
     snapshot_row.issued_to_staff_id IS DISTINCT FROM requested_staff OR
     EXISTS(SELECT 1 FROM myfin.transactions sale
       WHERE sale.company_id=requested_company AND sale.id=requested_checkout) THEN
    RAISE EXCEPTION 'pos_price_release_invalid' USING ERRCODE='23514';
  END IF;
  FOR reservation IN SELECT * FROM myfin.promotion_reservations held
    WHERE held.company_id=requested_company AND held.source_type='pos_sale'
      AND held.pos_checkout_id=requested_checkout AND held.pricing_snapshot_id=requested_snapshot
      AND held.state='active' ORDER BY held.promotion_id FOR UPDATE
  LOOP
    PERFORM 1 FROM myfin.promotions promotion
      WHERE promotion.workspace_id=reservation.workspace_id
        AND promotion.company_id=reservation.company_id
        AND promotion.id=reservation.promotion_id FOR UPDATE;
    UPDATE myfin.promotion_reservations SET state='released',released_at=now(),
      release_reason='cashier_cancelled',updated_at=now()
      WHERE workspace_id=reservation.workspace_id AND company_id=reservation.company_id
        AND order_id=reservation.order_id AND promotion_id=reservation.promotion_id
      RETURNING * INTO reservation;
    PERFORM myfin.append_promotion_reservation_event(
      reservation,'released','active','released','cashier_cancelled');
    released_count := released_count+1;
  END LOOP;
  RETURN released_count;
END $$;

CREATE TABLE myfin.pos_pricing_recovery_exceptions (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  checkout_id text NOT NULL,
  pricing_snapshot_id text NOT NULL,
  receipt_review_id text NOT NULL,
  approved_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,checkout_id,pricing_snapshot_id),
  FOREIGN KEY(workspace_id,company_id)
    REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,pricing_snapshot_id)
    REFERENCES myfin.pricing_snapshots(workspace_id,company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,receipt_review_id)
    REFERENCES myfin.receipt_reviews(company_id,id) ON DELETE RESTRICT,
  CHECK(checkout_id=receipt_review_id)
);

CREATE FUNCTION myfin.protect_pos_pricing_recovery_exception() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'pos_pricing_recovery_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_pos_pricing_recovery_exceptions
  BEFORE UPDATE OR DELETE ON myfin.pos_pricing_recovery_exceptions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_pos_pricing_recovery_exception();
CREATE TRIGGER no_truncate_pos_pricing_recovery_exceptions
  BEFORE TRUNCATE ON myfin.pos_pricing_recovery_exceptions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_pos_pricing_recovery_exception();

CREATE FUNCTION myfin.pos_pricing_recovery_authorized(
  requested_company text, requested_checkout text, requested_snapshot text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
  SELECT EXISTS(
    SELECT 1 FROM myfin.pos_pricing_recovery_exceptions recovery
     WHERE recovery.company_id=requested_company
       AND recovery.checkout_id=requested_checkout
       AND recovery.pricing_snapshot_id=requested_snapshot
  )
$$;

CREATE FUNCTION myfin.authorize_pos_pricing_recovery(
  requested_company text, requested_checkout text, requested_snapshot text,
  requested_approver text, requested_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE snapshot_row myfin.pricing_snapshots%ROWTYPE;
  review_row myfin.receipt_reviews%ROWTYPE;
  company_workspace text;
  captured_at timestamptz;
BEGIN
  SELECT * INTO snapshot_row FROM myfin.pricing_snapshots snapshot
    WHERE snapshot.company_id=requested_company AND snapshot.id=requested_snapshot FOR SHARE;
  SELECT * INTO review_row FROM myfin.receipt_reviews review
    WHERE review.company_id=requested_company AND review.id=requested_checkout FOR UPDATE;
  SELECT workspace_id INTO company_workspace FROM myfin.companies WHERE id=requested_company;
  IF snapshot_row.id IS NULL OR review_row.id IS NULL OR snapshot_row.channel<>'pos' OR
     snapshot_row.recovery_expires_at IS NULL OR
     review_row.status<>'pending' OR
     review_row.actor_id IS DISTINCT FROM snapshot_row.issued_to_staff_id OR
     review_row.payload->>'id' IS DISTINCT FROM requested_checkout OR
     review_row.payload->>'pricingSnapshotId' IS DISTINCT FROM requested_snapshot OR
     length(btrim(coalesce(requested_reason,''))) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'pos_pricing_recovery_invalid' USING ERRCODE='23514';
  END IF;
  BEGIN
    captured_at := (review_row.payload->>'date')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'pos_pricing_recovery_invalid' USING ERRCODE='23514';
  END;
  IF NOT EXISTS(
    SELECT 1 FROM myfin.app_identities actor_identity
     WHERE actor_identity.id=requested_approver AND actor_identity.disabled_at IS NULL AND (
       actor_identity.is_super OR EXISTS(SELECT 1 FROM myfin.workspace_memberships membership
         WHERE membership.workspace_id=company_workspace AND membership.identity_id=actor_identity.id
            AND membership.suspended_at IS NULL) OR EXISTS(SELECT 1 FROM myfin.memberships membership
         WHERE membership.company_id=requested_company AND membership.identity_id=actor_identity.id
            AND membership.role='manager')
      )
  ) THEN
    RAISE EXCEPTION 'pos_pricing_recovery_invalid' USING ERRCODE='23514';
  END IF;
  INSERT INTO myfin.pos_pricing_recovery_exceptions(
    workspace_id,company_id,checkout_id,pricing_snapshot_id,receipt_review_id,approved_by,reason)
  VALUES(snapshot_row.workspace_id,requested_company,requested_checkout,requested_snapshot,
    requested_checkout,requested_approver,btrim(requested_reason))
  ON CONFLICT(workspace_id,company_id,checkout_id,pricing_snapshot_id) DO NOTHING;
END $$;

CREATE FUNCTION myfin.enforce_pos_promotion_redemption() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE
  reservation myfin.promotion_reservations%ROWTYPE;
  snapshot_row myfin.pricing_snapshots%ROWTYPE;
  sale myfin.transactions%ROWTYPE;
  recovery_approved boolean;
BEGIN
  SELECT * INTO reservation FROM myfin.promotion_reservations held
    WHERE held.workspace_id=NEW.workspace_id AND held.company_id=NEW.company_id
      AND held.source_type='pos_sale' AND held.pos_checkout_id=NEW.source_id
      AND held.promotion_id=NEW.promotion_id AND held.promotion_version=NEW.promotion_version
      AND held.voucher_id IS NOT DISTINCT FROM NEW.voucher_id
      AND held.voucher_version IS NOT DISTINCT FROM NEW.voucher_version
      AND held.pricing_snapshot_id=NEW.pricing_snapshot_id
      AND held.customer_id IS NOT DISTINCT FROM NEW.customer_id
      AND held.discount_sen=NEW.discount_sen AND held.state IN ('active','released')
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_promotion_reservation_required' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS(SELECT 1 FROM myfin.pos_pricing_recovery_exceptions recovery
    WHERE recovery.workspace_id=NEW.workspace_id AND recovery.company_id=NEW.company_id
      AND recovery.checkout_id=NEW.source_id
      AND recovery.pricing_snapshot_id=NEW.pricing_snapshot_id)
    INTO recovery_approved;
  IF (reservation.state<>'active' OR now()>=reservation.expires_at OR
      NEW.occurred_at>=reservation.expires_at) AND NOT recovery_approved THEN
    RAISE EXCEPTION 'promotion_reservation_expired' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM myfin.promotions promotion
    WHERE promotion.workspace_id=reservation.workspace_id
      AND promotion.company_id=reservation.company_id
      AND promotion.id=reservation.promotion_id FOR UPDATE;
  IF reservation.voucher_id IS NOT NULL THEN
    PERFORM 1 FROM myfin.promotion_vouchers voucher
      WHERE voucher.workspace_id=reservation.workspace_id
        AND voucher.company_id=reservation.company_id
        AND voucher.promotion_id=reservation.promotion_id
        AND voucher.id=reservation.voucher_id FOR UPDATE;
  END IF;
  SELECT * INTO snapshot_row FROM myfin.pricing_snapshots snapshot
    WHERE snapshot.workspace_id=NEW.workspace_id AND snapshot.company_id=NEW.company_id
      AND snapshot.id=NEW.pricing_snapshot_id FOR SHARE;
  SELECT * INTO sale FROM myfin.transactions transaction_row
    WHERE transaction_row.company_id=NEW.company_id AND transaction_row.id=NEW.source_id FOR SHARE;
  IF snapshot_row.id IS NULL OR sale.id IS NULL OR snapshot_row.channel<>'pos' OR
     snapshot_row.customer_id IS DISTINCT FROM NEW.customer_id OR
     sale.source<>'pos' OR sale.pricing_snapshot_id IS DISTINCT FROM NEW.pricing_snapshot_id OR
     sale.data->>'cashierId' IS DISTINCT FROM snapshot_row.issued_to_staff_id THEN
    RAISE EXCEPTION 'promotion_reserved_source_invalid' USING ERRCODE='23514';
  END IF;
  PERFORM myfin.apply_reserved_promotion_usage(reservation);
  IF reservation.state='active' THEN
    UPDATE myfin.promotion_reservations SET state='consumed',consumed_at=NEW.occurred_at,updated_at=now()
      WHERE workspace_id=reservation.workspace_id AND company_id=reservation.company_id
        AND order_id=reservation.order_id AND promotion_id=reservation.promotion_id
      RETURNING * INTO reservation;
    PERFORM myfin.append_promotion_reservation_event(reservation,'consumed','active','consumed',
      CASE WHEN recovery_approved THEN 'paid_pos_recovery' ELSE 'paid_pos' END);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER promotion_redemption_limit_guard ON myfin.promotion_redemptions;
CREATE TRIGGER promotion_redemption_limit_guard
  BEFORE INSERT ON myfin.promotion_redemptions
  FOR EACH ROW WHEN (NEW.source_type<>'pos_sale')
  EXECUTE FUNCTION myfin.enforce_promotion_redemption();
CREATE TRIGGER pos_promotion_redemption_limit_guard
  BEFORE INSERT ON myfin.promotion_redemptions
  FOR EACH ROW WHEN (NEW.source_type='pos_sale')
  EXECUTE FUNCTION myfin.enforce_pos_promotion_redemption();

REVOKE ALL ON FUNCTION myfin.enforce_promotion_reservation_source() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.restrict_reserved_customer_order_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.reserve_pos_promotions(text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.release_pos_promotions(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.authorize_pos_pricing_recovery(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.pos_pricing_recovery_authorized(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_pos_promotion_redemption() FROM PUBLIC;

COMMENT ON COLUMN myfin.promotion_reservations.source_type IS
  'Capacity ledger source. POS price locks and online orders share the same usage limits.';
COMMENT ON COLUMN myfin.promotion_reservations.pos_checkout_id IS
  'Stable cart/sale identifier used to replace and later consume a POS price lock.';

-- Receipt reviews keep a paid intent before it becomes a transaction. Expose
-- the immutable snapshot reference as a generated relational key so cleanup
-- and a concurrently inserted review cannot race through a JSON-only link.
ALTER TABLE myfin.receipt_reviews
  ADD COLUMN pricing_snapshot_id text
    GENERATED ALWAYS AS (nullif(payload->>'pricingSnapshotId','')) STORED,
  ADD CONSTRAINT receipt_reviews_pricing_snapshot_fkey
    FOREIGN KEY(company_id,pricing_snapshot_id)
    REFERENCES myfin.pricing_snapshots(company_id,id) ON DELETE RESTRICT;

CREATE INDEX receipt_reviews_pricing_snapshot_idx
  ON myfin.receipt_reviews(company_id,pricing_snapshot_id)
  WHERE pricing_snapshot_id IS NOT NULL;

COMMENT ON COLUMN myfin.receipt_reviews.pricing_snapshot_id IS
  'Generated relational binder for the immutable POS price referenced by this paid receipt intent.';

-- Storefront price previews are immutable while they can still become an order,
-- but an expired preview that was never bound to any business record is neither
-- accounting evidence nor customer history. Keep a full day for delayed clients
-- and diagnostics, then let the existing maintenance worker reclaim a bounded
-- batch. The partial index prevents public quote volume from turning the scan
-- into a full-table walk.
CREATE INDEX pricing_snapshots_storefront_expiry_cleanup_idx
  ON myfin.pricing_snapshots(expires_at,workspace_id,company_id,id)
  WHERE channel='storefront';

-- The history trigger remains fail-closed for every ordinary UPDATE, DELETE and
-- TRUNCATE. Its only exception is DELETE from the four pricing evidence tables
-- while the table owner is executing the guarded cleanup function below. The
-- runtime role has no DELETE privilege on these tables and cannot satisfy the
-- owner check merely by setting the transaction-local marker.
CREATE OR REPLACE FUNCTION myfin.protect_promotion_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  table_owner name;
BEGIN
  IF TG_OP='DELETE' AND TG_TABLE_SCHEMA='myfin' AND
     TG_TABLE_NAME=ANY(ARRAY['pricing_snapshots','pricing_snapshot_lines',
       'pricing_snapshot_discounts','pricing_snapshot_discount_lines']) AND
     current_setting('myfin.expired_pricing_snapshot_cleanup',true)='on' THEN
    SELECT pg_catalog.pg_get_userbyid(table_row.relowner) INTO table_owner
      FROM pg_catalog.pg_class table_row
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid=table_row.relnamespace
     WHERE namespace_row.nspname=TG_TABLE_SCHEMA AND table_row.relname=TG_TABLE_NAME;
    IF table_owner=current_user THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'promotion_history_immutable' USING ERRCODE='23514';
END $$;

CREATE FUNCTION myfin.cleanup_expired_unbound_storefront_pricing_snapshots(
  requested_limit integer
) RETURNS TABLE(selected_count integer,deleted_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE
  candidate record;
  picked integer := 0;
  removed integer := 0;
BEGIN
  IF requested_limit IS NULL OR requested_limit<1 OR requested_limit>500 THEN
    RAISE EXCEPTION 'invalid_pricing_snapshot_cleanup_limit' USING ERRCODE='22023';
  END IF;

  -- The marker is local to this transaction. The immutable trigger also checks
  -- that the effective role owns the table, so a runtime caller cannot use the
  -- marker as a general history-delete bypass.
  PERFORM set_config('myfin.expired_pricing_snapshot_cleanup','on',true);
  FOR candidate IN
    SELECT snapshot.workspace_id,snapshot.company_id,snapshot.id
      FROM myfin.pricing_snapshots snapshot
     WHERE snapshot.channel='storefront'
       AND snapshot.expires_at<=statement_timestamp()-interval '24 hours'
       AND NOT EXISTS(SELECT 1 FROM myfin.customer_order_requests order_row
         WHERE order_row.company_id=snapshot.company_id
           AND order_row.pricing_snapshot_id=snapshot.id)
       AND NOT EXISTS(SELECT 1 FROM myfin.transactions transaction_row
         WHERE transaction_row.company_id=snapshot.company_id
           AND transaction_row.pricing_snapshot_id=snapshot.id)
       AND NOT EXISTS(SELECT 1 FROM myfin.promotion_redemptions redemption
         WHERE redemption.workspace_id=snapshot.workspace_id
           AND redemption.company_id=snapshot.company_id
           AND redemption.pricing_snapshot_id=snapshot.id)
       AND NOT EXISTS(SELECT 1 FROM myfin.promotion_reservations reservation
         WHERE reservation.workspace_id=snapshot.workspace_id
           AND reservation.company_id=snapshot.company_id
           AND reservation.pricing_snapshot_id=snapshot.id)
       AND NOT EXISTS(SELECT 1 FROM myfin.pos_pricing_recovery_exceptions recovery
          WHERE recovery.workspace_id=snapshot.workspace_id
            AND recovery.company_id=snapshot.company_id
            AND recovery.pricing_snapshot_id=snapshot.id)
       AND NOT EXISTS(SELECT 1 FROM myfin.receipt_reviews review
          WHERE review.company_id=snapshot.company_id
            AND review.pricing_snapshot_id=snapshot.id)
     ORDER BY snapshot.expires_at,snapshot.workspace_id,snapshot.company_id,snapshot.id
     LIMIT requested_limit
     FOR UPDATE OF snapshot SKIP LOCKED
  LOOP
    picked := picked+1;
    BEGIN
      DELETE FROM myfin.pricing_snapshot_discount_lines detail
       WHERE detail.workspace_id=candidate.workspace_id
         AND detail.company_id=candidate.company_id AND detail.snapshot_id=candidate.id;
      DELETE FROM myfin.pricing_snapshot_discounts discount_row
       WHERE discount_row.workspace_id=candidate.workspace_id
         AND discount_row.company_id=candidate.company_id AND discount_row.snapshot_id=candidate.id;
      DELETE FROM myfin.pricing_snapshot_lines line_row
       WHERE line_row.workspace_id=candidate.workspace_id
         AND line_row.company_id=candidate.company_id AND line_row.snapshot_id=candidate.id;
      DELETE FROM myfin.pricing_snapshots snapshot
       WHERE snapshot.workspace_id=candidate.workspace_id
         AND snapshot.company_id=candidate.company_id AND snapshot.id=candidate.id
         AND snapshot.channel='storefront'
         AND snapshot.expires_at<=statement_timestamp()-interval '24 hours'
         AND NOT EXISTS(SELECT 1 FROM myfin.customer_order_requests order_row
           WHERE order_row.company_id=snapshot.company_id
             AND order_row.pricing_snapshot_id=snapshot.id)
         AND NOT EXISTS(SELECT 1 FROM myfin.transactions transaction_row
           WHERE transaction_row.company_id=snapshot.company_id
             AND transaction_row.pricing_snapshot_id=snapshot.id)
         AND NOT EXISTS(SELECT 1 FROM myfin.promotion_redemptions redemption
           WHERE redemption.workspace_id=snapshot.workspace_id
             AND redemption.company_id=snapshot.company_id
             AND redemption.pricing_snapshot_id=snapshot.id)
         AND NOT EXISTS(SELECT 1 FROM myfin.promotion_reservations reservation
           WHERE reservation.workspace_id=snapshot.workspace_id
             AND reservation.company_id=snapshot.company_id
             AND reservation.pricing_snapshot_id=snapshot.id)
         AND NOT EXISTS(SELECT 1 FROM myfin.pos_pricing_recovery_exceptions recovery
            WHERE recovery.workspace_id=snapshot.workspace_id
              AND recovery.company_id=snapshot.company_id
              AND recovery.pricing_snapshot_id=snapshot.id)
         AND NOT EXISTS(SELECT 1 FROM myfin.receipt_reviews review
            WHERE review.company_id=snapshot.company_id
              AND review.pricing_snapshot_id=snapshot.id);
      IF FOUND THEN removed := removed+1; END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      -- A concurrent reference wins. The subtransaction restores every detail
      -- row and the next maintenance cycle can reassess the snapshot safely.
      NULL;
    END;
  END LOOP;
  PERFORM set_config('myfin.expired_pricing_snapshot_cleanup','off',true);
  RETURN QUERY SELECT picked,removed;
END $$;

REVOKE ALL ON FUNCTION myfin.cleanup_expired_unbound_storefront_pricing_snapshots(integer) FROM PUBLIC;

COMMENT ON FUNCTION myfin.cleanup_expired_unbound_storefront_pricing_snapshots(integer) IS
  'Deletes a bounded batch of storefront pricing previews expired for at least 24 hours and still unreferenced by any order, sale, receipt review, redemption, reservation or recovery record. POS snapshots are deliberately retained.';
