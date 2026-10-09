-- Accepted customer orders reserve the exact immutable recipe components that
-- tender will consume. Stock cannot be reduced or archived below live holds,
-- even when the mutation comes from a path other than customer-order checkout.

CREATE TABLE myfin.customer_order_recipe_reservations (
  company_id text NOT NULL,
  order_id text NOT NULL,
  line_no integer NOT NULL,
  stock_item_id text NOT NULL,
  recipe_id text NOT NULL,
  recipe_version bigint NOT NULL CHECK(recipe_version > 0),
  line_quantity numeric(12,3) NOT NULL CHECK(line_quantity > 0 AND line_quantity <= 1000),
  quantity_per_unit numeric(18,6) NOT NULL
    CHECK(quantity_per_unit > 0 AND quantity_per_unit <= 1000000000000),
  reserved_quantity numeric(18,6) NOT NULL
    CHECK(reserved_quantity > 0 AND reserved_quantity <= 1000000000000),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','released','consumed')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  consumed_at timestamptz,
  release_reason text NOT NULL DEFAULT '' CHECK(length(release_reason) <= 80),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,order_id,line_no,stock_item_id),
  FOREIGN KEY(company_id,order_id,line_no)
    REFERENCES myfin.customer_order_lines(company_id,order_id,line_no) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,recipe_id,recipe_version,stock_item_id)
    REFERENCES myfin.inventory_recipe_components(company_id,recipe_id,recipe_version,stock_item_id)
    ON DELETE RESTRICT,
  CHECK(reserved_quantity=round(line_quantity*quantity_per_unit,6)),
  CHECK(expires_at>reserved_at),
  CHECK(
    (state='active' AND released_at IS NULL AND consumed_at IS NULL AND release_reason='') OR
    (state='released' AND released_at IS NOT NULL AND consumed_at IS NULL AND length(btrim(release_reason))>0) OR
    (state='consumed' AND released_at IS NULL AND consumed_at IS NOT NULL AND release_reason='')
  )
);

CREATE INDEX customer_order_recipe_reservations_stock_active_idx
  ON myfin.customer_order_recipe_reservations(company_id,stock_item_id,expires_at,order_id)
  WHERE state='active';
CREATE INDEX customer_order_recipe_reservations_order_active_idx
  ON myfin.customer_order_recipe_reservations(company_id,order_id,line_no)
  WHERE state='active';

-- Validate each copied quantity against immutable order and recipe history.
-- Locking the stock row also serializes concurrent order acceptance and stock
-- mutations. The current order is counted while it is still transitioning from
-- awaiting_acceptance to accepted in the surrounding transaction.
CREATE FUNCTION myfin.validate_customer_order_recipe_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  existing myfin.customer_order_recipe_reservations%ROWTYPE;
  evidence record;
  stock record;
  held numeric;
BEGIN
  IF NEW.state<>'active' OR NEW.released_at IS NOT NULL OR NEW.consumed_at IS NOT NULL OR
     NEW.release_reason<>'' THEN
    RAISE EXCEPTION 'recipe_reservation_must_start_active' USING ERRCODE='23514';
  END IF;

  SELECT on_hand,active,tracking_mode INTO stock FROM myfin.stock_items
    WHERE company_id=NEW.company_id AND id=NEW.stock_item_id FOR UPDATE;
  IF NOT FOUND OR NOT stock.active THEN
    RAISE EXCEPTION 'recipe_reservation_stock_unavailable' USING ERRCODE='23514';
  END IF;

  SELECT * INTO existing FROM myfin.customer_order_recipe_reservations
    WHERE company_id=NEW.company_id AND order_id=NEW.order_id
      AND line_no=NEW.line_no AND stock_item_id=NEW.stock_item_id
    FOR UPDATE;
  IF FOUND THEN
    IF existing.recipe_id<>NEW.recipe_id OR existing.recipe_version<>NEW.recipe_version OR
       existing.line_quantity<>NEW.line_quantity OR
       existing.quantity_per_unit<>NEW.quantity_per_unit OR
       existing.reserved_quantity<>NEW.reserved_quantity OR
       existing.expires_at<>NEW.expires_at OR existing.state<>'active' THEN
      RAISE EXCEPTION 'recipe_reservation_changed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT line.quantity AS order_line_quantity,line.product_id AS line_product_id,
         line.variant_id AS line_variant_id,order_row.status AS order_status,
         order_row.payment_state,recipe.product_id AS recipe_product_id,
         recipe.variant_id AS recipe_variant_id,recipe.version AS current_recipe_version,
         recipe.enabled AS current_recipe_enabled,version_row.enabled AS version_enabled,
         version_row.catalog_stock_disabled,component.quantity_per_unit AS component_quantity
    INTO evidence
    FROM myfin.customer_order_lines line
    JOIN myfin.customer_order_requests order_row
      ON order_row.company_id=line.company_id AND order_row.id=line.order_id
    JOIN myfin.inventory_recipes recipe
      ON recipe.company_id=line.company_id AND recipe.id=NEW.recipe_id
    JOIN myfin.inventory_recipe_versions version_row
      ON version_row.company_id=recipe.company_id AND version_row.recipe_id=recipe.id
     AND version_row.version=NEW.recipe_version
    JOIN myfin.inventory_recipe_components component
      ON component.company_id=version_row.company_id AND component.recipe_id=version_row.recipe_id
     AND component.recipe_version=version_row.version AND component.stock_item_id=NEW.stock_item_id
   WHERE line.company_id=NEW.company_id AND line.order_id=NEW.order_id AND line.line_no=NEW.line_no
   FOR KEY SHARE OF line,order_row,recipe,version_row,component;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recipe_reservation_evidence_missing' USING ERRCODE='23514';
  END IF;
  IF evidence.payment_state<>'unpaid' OR
     evidence.order_status NOT IN ('awaiting_acceptance','accepted','preparing','ready') THEN
    RAISE EXCEPTION 'recipe_reservation_order_invalid' USING ERRCODE='23514';
  END IF;
  IF NOT evidence.current_recipe_enabled OR NOT evidence.version_enabled OR
     NOT evidence.catalog_stock_disabled OR
     evidence.current_recipe_version<>NEW.recipe_version OR
     evidence.recipe_product_id<>evidence.line_product_id OR
     (evidence.recipe_variant_id IS NOT NULL AND
       evidence.recipe_variant_id IS DISTINCT FROM evidence.line_variant_id) THEN
    RAISE EXCEPTION 'recipe_reservation_recipe_changed' USING ERRCODE='23514';
  END IF;
  IF NEW.line_quantity<>evidence.order_line_quantity OR
     NEW.quantity_per_unit<>evidence.component_quantity OR
     NEW.reserved_quantity<>round(evidence.order_line_quantity*evidence.component_quantity,6) THEN
    RAISE EXCEPTION 'recipe_reservation_quantity_changed' USING ERRCODE='23514';
  END IF;
  IF NEW.expires_at<=now() THEN
    RAISE EXCEPTION 'recipe_reservation_expired' USING ERRCODE='23514';
  END IF;

  IF stock.tracking_mode='count' AND NEW.reserved_quantity<>trunc(NEW.reserved_quantity) THEN
    RAISE EXCEPTION 'recipe_count_requires_whole_units' USING ERRCODE='23514';
  END IF;

  SELECT coalesce(sum(reservation.reserved_quantity),0) INTO held
    FROM myfin.customer_order_recipe_reservations reservation
    JOIN myfin.customer_order_requests held_order
      ON held_order.company_id=reservation.company_id AND held_order.id=reservation.order_id
   WHERE reservation.company_id=NEW.company_id AND reservation.stock_item_id=NEW.stock_item_id
     AND reservation.state='active' AND reservation.expires_at>now()
     AND (held_order.status IN ('accepted','preparing','ready') OR reservation.order_id=NEW.order_id);
  IF stock.on_hand<held+NEW.reserved_quantity THEN
    RAISE EXCEPTION 'recipe_stock_reserved_or_unavailable' USING ERRCODE='23514';
  END IF;

  NEW.reserved_at:=now();
  NEW.updated_at:=NEW.reserved_at;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_order_recipe_reservation_insert_guard
  BEFORE INSERT ON myfin.customer_order_recipe_reservations
  FOR EACH ROW EXECUTE FUNCTION myfin.validate_customer_order_recipe_reservation();

CREATE FUNCTION myfin.protect_customer_order_recipe_reservation() RETURNS trigger
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
     NEW.reserved_at IS DISTINCT FROM OLD.reserved_at OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'recipe_reservation_evidence_immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state<>'active' OR NEW.state NOT IN ('released','consumed') THEN
    RAISE EXCEPTION 'recipe_reservation_final' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_order_recipe_reservation_update_guard
  BEFORE UPDATE OR DELETE ON myfin.customer_order_recipe_reservations
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_customer_order_recipe_reservation();
CREATE TRIGGER no_truncate_customer_order_recipe_reservations
  BEFORE TRUNCATE ON myfin.customer_order_recipe_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_inventory_recipe_history();

CREATE FUNCTION myfin.enforce_recipe_reservation_stock_floor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE held numeric;
BEGIN
  IF (NEW.on_hand IS DISTINCT FROM OLD.on_hand AND NEW.on_hand<OLD.on_hand) OR
     (OLD.active AND NOT NEW.active) THEN
    SELECT coalesce(sum(reservation.reserved_quantity),0) INTO held
      FROM myfin.customer_order_recipe_reservations reservation
      JOIN myfin.customer_order_requests order_row
        ON order_row.company_id=reservation.company_id AND order_row.id=reservation.order_id
     WHERE reservation.company_id=NEW.company_id AND reservation.stock_item_id=NEW.id
       AND reservation.state='active' AND reservation.expires_at>now()
       AND order_row.status IN ('accepted','preparing','ready');
    IF OLD.active AND NOT NEW.active AND held>0 THEN
      RAISE EXCEPTION 'stock_item_has_active_recipe_reservations' USING ERRCODE='23514';
    END IF;
    IF NEW.on_hand<held THEN
      RAISE EXCEPTION 'stock_below_active_recipe_reservations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipe_reservation_stock_floor_guard
  BEFORE UPDATE OF on_hand,active ON myfin.stock_items
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_recipe_reservation_stock_floor();

-- A manager must record which recipe interpretation was used when an offline
-- sale crosses a recipe-version boundary. The choice is written atomically with
-- approval and remains part of the immutable paid-intent review.
ALTER TABLE myfin.receipt_reviews ADD COLUMN inventory_recipe_resolution text;
ALTER TABLE myfin.receipt_reviews ADD CONSTRAINT receipt_reviews_recipe_resolution_value
  CHECK(inventory_recipe_resolution IS NULL OR
    inventory_recipe_resolution IN ('current_recipe','captured_recipe'));
ALTER TABLE myfin.receipt_reviews ADD CONSTRAINT receipt_reviews_recipe_resolution_context
  CHECK(
    (inventory_recipe_resolution IS NULL OR
      (status='approved' AND coalesce(payload->>'offline','false')='true')) AND
    (status<>'approved' OR reason_code<>'receipt_review_required_recipe_timing' OR
      (coalesce(payload->>'offline','false')='true' AND inventory_recipe_resolution IS NOT NULL))
  );

CREATE OR REPLACE FUNCTION myfin.protect_receipt_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF TG_OP='UPDATE' AND
    (to_jsonb(NEW)-ARRAY['status','approved_by','approval_reason','approved_at','dismissed_by',
      'dismissal_reason','dismissed_at','inventory_recipe_resolution'])=
    (to_jsonb(OLD)-ARRAY['status','approved_by','approval_reason','approved_at','dismissed_by',
      'dismissal_reason','dismissed_at','inventory_recipe_resolution']) AND
    ((NEW IS NOT DISTINCT FROM OLD) OR
      (OLD.status='pending' AND NEW.status='approved' AND NEW.approved_by IS NOT NULL AND
       length(trim(NEW.approval_reason))>=3 AND NEW.approved_at IS NOT NULL AND
       NEW.dismissed_by IS NULL AND NEW.dismissed_at IS NULL AND
       (NEW.inventory_recipe_resolution IS NULL OR
          coalesce(NEW.payload->>'offline','false')='true') AND
       (NEW.reason_code<>'receipt_review_required_recipe_timing' OR
          NEW.inventory_recipe_resolution IN ('current_recipe','captured_recipe'))) OR
      (OLD.status='pending' AND NEW.status='dismissed' AND NEW.dismissed_by IS NOT NULL AND
       length(trim(NEW.dismissal_reason))>=3 AND NEW.dismissed_at IS NOT NULL AND
       NEW.approved_by IS NULL AND NEW.approved_at IS NULL AND
       NEW.inventory_recipe_resolution IS NULL))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'paid_intent_immutable' USING ERRCODE='23514';
END $$;

REVOKE ALL ON myfin.customer_order_recipe_reservations FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.validate_customer_order_recipe_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_customer_order_recipe_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_recipe_reservation_stock_floor() FROM PUBLIC;

COMMENT ON TABLE myfin.customer_order_recipe_reservations IS
  'Immutable recipe-version and quantity evidence reserved per accepted customer-order line and stock item.';
COMMENT ON COLUMN myfin.receipt_reviews.inventory_recipe_resolution IS
  'Manager choice for an approved offline sale whose recipe boundary was found during submission or later approval; forbidden on online receipts.';
