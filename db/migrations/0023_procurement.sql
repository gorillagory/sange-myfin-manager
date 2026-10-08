-- Procurement, identifier directory, receipt costing and low-stock alerts.
-- Supplier orders are always deliberate user actions: this migration does not
-- create an automatic reorder job or outbound supplier integration.

CREATE TABLE myfin.stock_identifiers (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  stock_item_id text NOT NULL,
  identifier_type text NOT NULL CHECK(identifier_type IN
    ('gtin','ean','upc','manufacturer_barcode','supplier_barcode','internal_sku','qr')),
  raw_value text NOT NULL CHECK(length(btrim(raw_value)) BETWEEN 1 AND 256),
  normalized_value text NOT NULL CHECK(length(normalized_value) BETWEEN 1 AND 256),
  supplier_id text,
  packaging_id text,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  archived_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,supplier_id)
    REFERENCES myfin.clients(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,stock_item_id,packaging_id)
    REFERENCES myfin.stock_packagings(company_id,item_id,id) ON DELETE RESTRICT,
  CHECK((active AND archived_at IS NULL AND archived_by IS NULL) OR
    (NOT active AND archived_at IS NOT NULL AND archived_by IS NOT NULL)),
  CHECK(normalized_value=upper(btrim(normalized_value))),
  CHECK(identifier_type<>'supplier_barcode' OR supplier_id IS NOT NULL)
);
-- One active scan value resolves to exactly one item inside a tenant, even if a
-- value was accidentally labelled with two different identifier types.
CREATE UNIQUE INDEX stock_identifiers_active_value_key
  ON myfin.stock_identifiers(company_id,normalized_value) WHERE active;
CREATE INDEX stock_identifiers_item_idx
  ON myfin.stock_identifiers(company_id,stock_item_id,active);

CREATE TABLE myfin.purchase_orders (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  number text NOT NULL CHECK(length(btrim(number)) BETWEEN 1 AND 64),
  supplier_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN
    ('draft','submitted','partially_received','received','cancelled')),
  currency_code text NOT NULL DEFAULT 'MYR' CHECK(currency_code ~ '^[A-Z]{3}$'),
  total_sen bigint NOT NULL CHECK(total_sen BETWEEN 0 AND 1000000000000000),
  expected_date date,
  notes text NOT NULL DEFAULT '' CHECK(length(notes) <= 10000),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  submitted_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  cancelled_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,number),
  UNIQUE(company_id,idempotency_key),
  FOREIGN KEY(company_id,supplier_id)
    REFERENCES myfin.clients(company_id,id) ON DELETE RESTRICT,
  CHECK((status='draft' AND submitted_at IS NULL) OR status<>'draft'),
  CHECK((status='cancelled')=(cancelled_at IS NOT NULL)),
  CHECK((cancelled_at IS NULL)=(cancelled_by IS NULL))
);
COMMENT ON TABLE myfin.purchase_orders IS
  'API drafts use create, submit or cancel. There is intentionally no in-place draft edit: corrections create a replacement draft, preserving the original audit record.';
CREATE INDEX purchase_orders_supplier_date_idx
  ON myfin.purchase_orders(company_id,supplier_id,created_at DESC);

CREATE TABLE myfin.purchase_order_lines (
  company_id text NOT NULL,
  purchase_order_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  position integer NOT NULL CHECK(position BETWEEN 0 AND 499),
  stock_item_id text NOT NULL,
  supplier_item_reference text NOT NULL DEFAULT '' CHECK(length(supplier_item_reference) <= 128),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 500),
  purchase_unit text NOT NULL CHECK(length(btrim(purchase_unit)) BETWEEN 1 AND 32),
  ordered_purchase_quantity numeric(18,6) NOT NULL
    CHECK(ordered_purchase_quantity > 0 AND ordered_purchase_quantity <= 1000000),
  quantity_in_base numeric(18,6) NOT NULL
    CHECK(quantity_in_base > 0 AND quantity_in_base <= 1000000),
  unit_price_sen bigint NOT NULL CHECK(unit_price_sen BETWEEN 0 AND 1000000000),
  line_total_sen bigint NOT NULL CHECK(line_total_sen BETWEEN 0 AND 1000000000000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,purchase_order_id,id),
  UNIQUE(company_id,purchase_order_id,id,stock_item_id),
  UNIQUE(company_id,purchase_order_id,position),
  FOREIGN KEY(company_id,purchase_order_id)
    REFERENCES myfin.purchase_orders(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX purchase_order_lines_stock_idx
  ON myfin.purchase_order_lines(company_id,stock_item_id,purchase_order_id);

CREATE TABLE myfin.purchase_order_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  purchase_order_id text NOT NULL,
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK(event_type IN
    ('created','submitted','partially_received','received','cancelled','receipt_reversed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,purchase_order_id)
    REFERENCES myfin.purchase_orders(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX purchase_order_events_order_idx
  ON myfin.purchase_order_events(company_id,purchase_order_id,created_at,id);

CREATE TABLE myfin.goods_receipts (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  purchase_order_id text NOT NULL,
  reference text NOT NULL DEFAULT '' CHECK(length(reference) <= 128),
  received_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  received_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,idempotency_key),
  FOREIGN KEY(company_id,purchase_order_id)
    REFERENCES myfin.purchase_orders(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX goods_receipts_order_idx
  ON myfin.goods_receipts(company_id,purchase_order_id,received_at,id);

CREATE TABLE myfin.goods_receipt_lines (
  company_id text NOT NULL,
  goods_receipt_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  purchase_order_id text NOT NULL,
  purchase_order_line_id text NOT NULL,
  stock_item_id text NOT NULL,
  received_purchase_quantity numeric(18,6) NOT NULL
    CHECK(received_purchase_quantity > 0 AND received_purchase_quantity <= 1000000),
  base_quantity numeric(18,6) NOT NULL CHECK(base_quantity > 0 AND base_quantity <= 1000000000000),
  cost_sen bigint NOT NULL CHECK(cost_sen BETWEEN 0 AND 1000000000000000),
  batch_code text NOT NULL DEFAULT '' CHECK(length(batch_code) <= 128),
  lot_code text NOT NULL DEFAULT '' CHECK(length(lot_code) <= 128),
  expiry_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,goods_receipt_id,id),
  UNIQUE(company_id,goods_receipt_id,id,stock_item_id),
  UNIQUE(company_id,goods_receipt_id,purchase_order_line_id),
  FOREIGN KEY(company_id,goods_receipt_id)
    REFERENCES myfin.goods_receipts(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,purchase_order_id,purchase_order_line_id,stock_item_id)
    REFERENCES myfin.purchase_order_lines(company_id,purchase_order_id,id,stock_item_id) ON DELETE RESTRICT
);
CREATE INDEX goods_receipt_lines_order_line_idx
  ON myfin.goods_receipt_lines(company_id,purchase_order_id,purchase_order_line_id);

CREATE TABLE myfin.stock_batches (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  stock_item_id text NOT NULL,
  goods_receipt_id text NOT NULL,
  goods_receipt_line_id text NOT NULL,
  batch_code text NOT NULL DEFAULT '' CHECK(length(batch_code) <= 128),
  lot_code text NOT NULL DEFAULT '' CHECK(length(lot_code) <= 128),
  expiry_date date,
  received_quantity numeric(18,6) NOT NULL CHECK(received_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,goods_receipt_id,goods_receipt_line_id),
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,goods_receipt_id,goods_receipt_line_id,stock_item_id)
    REFERENCES myfin.goods_receipt_lines(company_id,goods_receipt_id,id,stock_item_id) ON DELETE RESTRICT,
  CHECK(batch_code<>'' OR lot_code<>'' OR expiry_date IS NOT NULL)
);
COMMENT ON TABLE myfin.stock_batches IS
  'Receipt provenance and lot/expiry evidence only. Remaining-batch balances and FEFO consumption are not implemented by migration 0023.';
CREATE INDEX stock_batches_expiry_idx
  ON myfin.stock_batches(company_id,expiry_date,stock_item_id)
  WHERE expiry_date IS NOT NULL;

-- Reversals are full, explicit, append-only compensating records. The original
-- receipt remains intact and auditable.
CREATE TABLE myfin.goods_receipt_reversals (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  goods_receipt_id text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  reversed_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,goods_receipt_id),
  UNIQUE(company_id,idempotency_key),
  FOREIGN KEY(company_id,goods_receipt_id)
    REFERENCES myfin.goods_receipts(company_id,id) ON DELETE RESTRICT
);

CREATE TABLE myfin.inventory_weighted_costs (
  company_id text NOT NULL,
  stock_item_id text NOT NULL,
  cumulative_received_quantity numeric(18,6) NOT NULL DEFAULT 0
    CHECK(cumulative_received_quantity BETWEEN 0 AND 1000000000000),
  cumulative_value_sen bigint NOT NULL DEFAULT 0
    CHECK(cumulative_value_sen BETWEEN 0 AND 1000000000000000),
  average_cost_sen numeric(24,8) NOT NULL DEFAULT 0 CHECK(average_cost_sen >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,stock_item_id),
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT
);

CREATE TABLE myfin.inventory_valuation_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  stock_item_id text NOT NULL,
  source_type text NOT NULL CHECK(source_type IN ('goods_receipt','goods_receipt_reversal')),
  source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  quantity_delta numeric(18,6) NOT NULL CHECK(quantity_delta<>0),
  value_delta_sen bigint NOT NULL,
  cumulative_received_quantity numeric(18,6) NOT NULL CHECK(cumulative_received_quantity >= 0),
  cumulative_value_sen bigint NOT NULL CHECK(cumulative_value_sen >= 0),
  average_cost_sen numeric(24,8) NOT NULL CHECK(average_cost_sen >= 0),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,source_type,source_id,stock_item_id),
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX inventory_valuation_events_item_idx
  ON myfin.inventory_valuation_events(company_id,stock_item_id,created_at,id);

ALTER TABLE myfin.stock_ledger ADD COLUMN procurement_receipt_id text;
ALTER TABLE myfin.stock_ledger ADD COLUMN procurement_receipt_line_id text;
ALTER TABLE myfin.stock_ledger ADD COLUMN procurement_effect text;
ALTER TABLE myfin.stock_ledger ADD CONSTRAINT stock_ledger_procurement_triplet
  CHECK((procurement_receipt_id IS NULL AND procurement_receipt_line_id IS NULL AND procurement_effect IS NULL) OR
    (procurement_receipt_id IS NOT NULL AND procurement_receipt_line_id IS NOT NULL AND
      procurement_effect IN ('receive','reversal')));
ALTER TABLE myfin.stock_ledger ADD CONSTRAINT stock_ledger_procurement_line_fk
  FOREIGN KEY(company_id,procurement_receipt_id,procurement_receipt_line_id,item_id)
  REFERENCES myfin.goods_receipt_lines(company_id,goods_receipt_id,id,stock_item_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX stock_ledger_procurement_effect_key
  ON myfin.stock_ledger(company_id,procurement_receipt_id,procurement_receipt_line_id,procurement_effect)
  WHERE procurement_receipt_id IS NOT NULL;

CREATE TABLE myfin.low_stock_alerts (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  stock_item_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('open','acknowledged','resolved')),
  observed_quantity numeric(18,6) NOT NULL CHECK(observed_quantity >= 0),
  reorder_threshold numeric(18,6) NOT NULL CHECK(reorder_threshold > 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT,
  CHECK((status='open' AND acknowledged_at IS NULL) OR
    (status='acknowledged' AND acknowledged_at IS NOT NULL) OR status='resolved'),
  CHECK((acknowledged_at IS NULL)=(acknowledged_by IS NULL)),
  CHECK((status='resolved')=(resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX low_stock_alerts_active_item_key
  ON myfin.low_stock_alerts(company_id,stock_item_id)
  WHERE status IN ('open','acknowledged');
CREATE INDEX low_stock_alerts_status_idx
  ON myfin.low_stock_alerts(company_id,status,opened_at DESC);

CREATE TABLE myfin.low_stock_alert_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  alert_id text NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('opened','acknowledged','resolved')),
  actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,alert_id)
    REFERENCES myfin.low_stock_alerts(company_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION myfin.protect_procurement_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'procurement_evidence_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_purchase_order_events BEFORE UPDATE OR DELETE ON myfin.purchase_order_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER immutable_goods_receipts BEFORE UPDATE OR DELETE ON myfin.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER immutable_goods_receipt_lines BEFORE UPDATE OR DELETE ON myfin.goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER immutable_goods_receipt_reversals BEFORE UPDATE OR DELETE ON myfin.goods_receipt_reversals
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER immutable_stock_batches BEFORE UPDATE OR DELETE ON myfin.stock_batches
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER immutable_inventory_valuation_events BEFORE UPDATE OR DELETE ON myfin.inventory_valuation_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER immutable_low_stock_alert_events BEFORE UPDATE OR DELETE ON myfin.low_stock_alert_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_procurement_evidence();
-- Row triggers do not fire for TRUNCATE, so append-only evidence has explicit
-- statement-level guards as well.
CREATE TRIGGER truncate_purchase_order_events BEFORE TRUNCATE ON myfin.purchase_order_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER truncate_goods_receipts BEFORE TRUNCATE ON myfin.goods_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER truncate_goods_receipt_lines BEFORE TRUNCATE ON myfin.goods_receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER truncate_goods_receipt_reversals BEFORE TRUNCATE ON myfin.goods_receipt_reversals
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER truncate_stock_batches BEFORE TRUNCATE ON myfin.stock_batches
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER truncate_inventory_valuation_events BEFORE TRUNCATE ON myfin.inventory_valuation_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();
CREATE TRIGGER truncate_low_stock_alert_events BEFORE TRUNCATE ON myfin.low_stock_alert_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();

CREATE FUNCTION myfin.protect_stock_identifier() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'stock_identifier_delete_forbidden' USING ERRCODE='23514';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.id IS DISTINCT FROM OLD.id OR
     NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id OR
     NEW.identifier_type IS DISTINCT FROM OLD.identifier_type OR
     NEW.raw_value IS DISTINCT FROM OLD.raw_value OR
     NEW.normalized_value IS DISTINCT FROM OLD.normalized_value OR
     NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR
     NEW.packaging_id IS DISTINCT FROM OLD.packaging_id OR
     (NOT OLD.active AND NEW.active) THEN
    RAISE EXCEPTION 'stock_identifier_identity_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_identifier_guard BEFORE UPDATE OR DELETE ON myfin.stock_identifiers
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_stock_identifier();
CREATE TRIGGER truncate_stock_identifiers BEFORE TRUNCATE ON myfin.stock_identifiers
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();

CREATE FUNCTION myfin.protect_purchase_order_line() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE order_status text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'purchase_order_line_delete_forbidden' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'purchase_order_line_edit_forbidden' USING ERRCODE='23514';
  END IF;
  SELECT status INTO order_status FROM myfin.purchase_orders
    WHERE company_id=NEW.company_id AND id=NEW.purchase_order_id;
  IF TG_OP='INSERT' AND order_status<>'draft' THEN
    RAISE EXCEPTION 'submitted_purchase_order_line_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_order_line_guard BEFORE INSERT OR UPDATE OR DELETE ON myfin.purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_purchase_order_line();
CREATE TRIGGER truncate_purchase_order_lines BEFORE TRUNCATE ON myfin.purchase_order_lines
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();

CREATE FUNCTION myfin.enforce_purchase_order_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE line_count integer; line_total bigint; received_none boolean;
  received_any boolean; received_complete boolean; received_within boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'purchase_order_delete_forbidden' USING ERRCODE='23514';
  END IF;
  IF (
    NEW.number IS DISTINCT FROM OLD.number OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR
    NEW.currency_code IS DISTINCT FROM OLD.currency_code OR NEW.total_sen IS DISTINCT FROM OLD.total_sen OR
    NEW.expected_date IS DISTINCT FROM OLD.expected_date OR NEW.notes IS DISTINCT FROM OLD.notes
  ) THEN
    RAISE EXCEPTION 'submitted_purchase_order_snapshot_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='draft' AND NEW.status IN ('submitted','cancelled')) OR
    (OLD.status='submitted' AND NEW.status IN ('partially_received','received','cancelled')) OR
    (OLD.status='partially_received' AND NEW.status IN ('submitted','received','cancelled')) OR
    (OLD.status='received' AND NEW.status IN ('submitted','partially_received'))
  ) THEN
    RAISE EXCEPTION 'invalid_purchase_order_transition' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('submitted','partially_received','received') THEN
    SELECT count(*),coalesce(sum(line.line_total_sen),0),
      bool_and(coalesce(receipt.received,0)=0),bool_or(coalesce(receipt.received,0)>0),
      bool_and(coalesce(receipt.received,0)=line.ordered_purchase_quantity),
      bool_and(coalesce(receipt.received,0)<=line.ordered_purchase_quantity)
      INTO line_count,line_total,received_none,received_any,received_complete,received_within
      FROM myfin.purchase_order_lines line
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(gl.received_purchase_quantity),0) AS received
        FROM myfin.goods_receipt_lines gl
        JOIN myfin.goods_receipts gr ON gr.company_id=gl.company_id AND gr.id=gl.goods_receipt_id
        LEFT JOIN myfin.goods_receipt_reversals rv
          ON rv.company_id=gr.company_id AND rv.goods_receipt_id=gr.id
        WHERE gl.company_id=line.company_id AND gl.purchase_order_id=line.purchase_order_id
          AND gl.purchase_order_line_id=line.id AND rv.id IS NULL
      ) receipt ON true
      WHERE line.company_id=NEW.company_id AND line.purchase_order_id=NEW.id;
    IF line_count=0 OR line_total<>NEW.total_sen THEN
      RAISE EXCEPTION 'purchase_order_total_mismatch' USING ERRCODE='23514';
    END IF;
    IF NOT received_within OR
       (NEW.status='submitted' AND NOT received_none) OR
       (NEW.status='partially_received' AND NOT(received_any AND NOT received_complete)) OR
       (NEW.status='received' AND NOT received_complete) THEN
      RAISE EXCEPTION 'purchase_order_receipt_status_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_order_lifecycle_guard BEFORE UPDATE OR DELETE ON myfin.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_purchase_order_lifecycle();
CREATE TRIGGER truncate_purchase_orders BEFORE TRUNCATE ON myfin.purchase_orders
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_procurement_evidence();

-- This trigger opens at most one active alert per stock item, preserves an
-- acknowledgement while the item stays low, and resolves it after recovery.
CREATE FUNCTION myfin.sync_low_stock_alert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE alert_id text; alert_status text; event_id text;
BEGIN
  SELECT id,status INTO alert_id,alert_status FROM myfin.low_stock_alerts
    WHERE company_id=NEW.company_id AND stock_item_id=NEW.id
      AND status IN ('open','acknowledged') FOR UPDATE;
  IF NEW.active AND NEW.reorder_level>0 AND NEW.on_hand<=NEW.reorder_level THEN
    IF alert_id IS NULL THEN
      alert_id='low-'||md5(jsonb_build_array(NEW.company_id,NEW.id,clock_timestamp()::text,random()::text)::text);
      INSERT INTO myfin.low_stock_alerts(company_id,id,stock_item_id,status,observed_quantity,reorder_threshold)
        VALUES(NEW.company_id,alert_id,NEW.id,'open',NEW.on_hand,NEW.reorder_level);
      event_id='low-event-'||md5(alert_id||clock_timestamp()::text||random()::text);
      INSERT INTO myfin.low_stock_alert_events(company_id,id,alert_id,event_type,details)
        VALUES(NEW.company_id,event_id,alert_id,'opened',jsonb_build_object(
          'observedQuantity',NEW.on_hand,'reorderThreshold',NEW.reorder_level));
    ELSE
      UPDATE myfin.low_stock_alerts SET observed_quantity=NEW.on_hand,
        reorder_threshold=NEW.reorder_level,version=version+1
        WHERE company_id=NEW.company_id AND id=alert_id;
    END IF;
  ELSIF alert_id IS NOT NULL THEN
    UPDATE myfin.low_stock_alerts SET status='resolved',observed_quantity=NEW.on_hand,
      resolved_at=now(),version=version+1
      WHERE company_id=NEW.company_id AND id=alert_id;
    event_id='low-event-'||md5(alert_id||clock_timestamp()::text||random()::text);
    INSERT INTO myfin.low_stock_alert_events(company_id,id,alert_id,event_type,details)
      VALUES(NEW.company_id,event_id,alert_id,'resolved',jsonb_build_object(
        'observedQuantity',NEW.on_hand,'reorderThreshold',NEW.reorder_level));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_item_low_stock_alert
  AFTER INSERT OR UPDATE OF on_hand,reorder_level,active ON myfin.stock_items
  FOR EACH ROW EXECUTE FUNCTION myfin.sync_low_stock_alert();

WITH seeded AS (
  INSERT INTO myfin.low_stock_alerts(company_id,id,stock_item_id,status,observed_quantity,reorder_threshold)
  SELECT company_id,'low-'||md5(jsonb_build_array(company_id,id,'migration-0023')::text),id,
    'open',on_hand,reorder_level FROM myfin.stock_items
  WHERE active AND reorder_level>0 AND on_hand<=reorder_level
  ON CONFLICT DO NOTHING RETURNING company_id,id,observed_quantity,reorder_threshold
)
INSERT INTO myfin.low_stock_alert_events(company_id,id,alert_id,event_type,details)
SELECT company_id,'low-event-'||md5(jsonb_build_array(id,'migration-0023')::text),id,'opened',
  jsonb_build_object('observedQuantity',observed_quantity,'reorderThreshold',reorder_threshold,'source','migration')
FROM seeded;
