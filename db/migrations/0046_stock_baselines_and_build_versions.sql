-- A baseline is an explicit, auditable "start from here" stock count. It lets a
-- company repopulate current balances without deleting old sales or rewriting
-- the immutable stock ledger.

-- Inventory builds already keep append-only versions. Snapshot the complete
-- stock measurement used by every component so later analytics remain exact
-- after a unit-label or tracking-mode correction.
ALTER TABLE myfin.inventory_recipe_components
  ADD COLUMN stock_tracking_mode text,
  ADD COLUMN stock_base_unit text,
  ADD COLUMN stock_unit_version bigint;
ALTER TABLE myfin.inventory_recipe_components DISABLE TRIGGER immutable_inventory_recipe_components;

-- Corrections became immutable history in migration 0045. Reconstruct each
-- older component from the latest correction effective when its build version
-- was created. Before 0045 no unit-change audit existed; for a version older
-- than the first retained correction, that correction's `from` measurement is
-- the earliest deterministic evidence available. With no correction at all,
-- the current stock measurement is the only retained evidence.
WITH component_snapshots AS (
  SELECT component.company_id,component.recipe_id,component.recipe_version,component.stock_item_id,
    coalesce(effective.to_tracking_mode,earliest.from_tracking_mode,item.tracking_mode) AS tracking_mode,
    coalesce(effective.to_base_unit,earliest.from_base_unit,item.base_unit) AS base_unit,
    coalesce(effective.to_unit_version,earliest.from_unit_version,item.unit_version) AS unit_version
  FROM myfin.inventory_recipe_components component
  JOIN myfin.inventory_recipe_versions build_version
    ON build_version.company_id=component.company_id
   AND build_version.recipe_id=component.recipe_id
   AND build_version.version=component.recipe_version
  JOIN myfin.stock_items item
    ON item.company_id=component.company_id AND item.id=component.stock_item_id
  LEFT JOIN LATERAL (
    SELECT correction.to_tracking_mode,correction.to_base_unit,correction.to_unit_version
    FROM myfin.stock_unit_corrections correction
    WHERE correction.company_id=component.company_id
      AND correction.stock_item_id=component.stock_item_id
      AND correction.created_at<=build_version.created_at
    ORDER BY correction.to_unit_version DESC
    LIMIT 1
  ) effective ON true
  LEFT JOIN LATERAL (
    SELECT correction.from_tracking_mode,correction.from_base_unit,correction.from_unit_version
    FROM myfin.stock_unit_corrections correction
    WHERE correction.company_id=component.company_id
      AND correction.stock_item_id=component.stock_item_id
    ORDER BY correction.from_unit_version
    LIMIT 1
  ) earliest ON true
)
UPDATE myfin.inventory_recipe_components component
SET stock_tracking_mode=snapshot.tracking_mode,
    stock_base_unit=snapshot.base_unit,
    stock_unit_version=snapshot.unit_version
FROM component_snapshots snapshot
WHERE snapshot.company_id=component.company_id
  AND snapshot.recipe_id=component.recipe_id
  AND snapshot.recipe_version=component.recipe_version
  AND snapshot.stock_item_id=component.stock_item_id;
ALTER TABLE myfin.inventory_recipe_components ENABLE TRIGGER immutable_inventory_recipe_components;
ALTER TABLE myfin.inventory_recipe_components
  ALTER COLUMN stock_tracking_mode SET NOT NULL,
  ALTER COLUMN stock_base_unit SET NOT NULL,
  ALTER COLUMN stock_unit_version SET NOT NULL,
  ADD CONSTRAINT inventory_recipe_component_tracking_mode
    CHECK(stock_tracking_mode IN ('count','weight','volume')),
  ADD CONSTRAINT inventory_recipe_component_base_unit
    CHECK(length(btrim(stock_base_unit)) BETWEEN 1 AND 32),
  ADD CONSTRAINT inventory_recipe_component_unit_version
    CHECK(stock_unit_version > 0);

-- Derive snapshots in PostgreSQL rather than trusting an application payload.
-- This also keeps an older API instance safe during migrate-before-restart:
-- its legacy INSERT omits these columns, and the trigger fills them correctly.
CREATE FUNCTION myfin.snapshot_inventory_recipe_component_unit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE item_row record;
BEGIN
  SELECT tracking_mode,base_unit,unit_version INTO item_row
    FROM myfin.stock_items
   WHERE company_id=NEW.company_id AND id=NEW.stock_item_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock_item_not_found' USING ERRCODE='23503';
  END IF;
  NEW.stock_tracking_mode:=item_row.tracking_mode;
  NEW.stock_base_unit:=item_row.base_unit;
  NEW.stock_unit_version:=item_row.unit_version;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_inventory_recipe_component_unit_before_insert
  BEFORE INSERT ON myfin.inventory_recipe_components
  FOR EACH ROW EXECUTE FUNCTION myfin.snapshot_inventory_recipe_component_unit();
REVOKE ALL ON FUNCTION myfin.snapshot_inventory_recipe_component_unit() FROM PUBLIC;

CREATE TABLE myfin.stock_baselines (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 1000),
  item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 500),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,idempotency_key)
);
CREATE INDEX stock_baselines_created_idx
  ON myfin.stock_baselines(company_id,created_at DESC,id DESC);

ALTER TABLE myfin.stock_ledger ADD COLUMN baseline_id text;
ALTER TABLE myfin.stock_ledger ADD CONSTRAINT stock_ledger_baseline_fk
  FOREIGN KEY(company_id,baseline_id)
  REFERENCES myfin.stock_baselines(company_id,id) ON DELETE RESTRICT;
CREATE INDEX stock_ledger_baseline_idx
  ON myfin.stock_ledger(company_id,baseline_id,item_id)
  WHERE baseline_id IS NOT NULL;

CREATE TABLE myfin.stock_baseline_items (
  company_id text NOT NULL,
  baseline_id text NOT NULL,
  stock_item_id text NOT NULL,
  stock_unit_version bigint NOT NULL CHECK(stock_unit_version > 0),
  quantity_before numeric(18,6) NOT NULL
    CHECK(quantity_before BETWEEN 0 AND 1000000000000),
  quantity_after numeric(18,6) NOT NULL
    CHECK(quantity_after BETWEEN 0 AND 1000000000000),
  ledger_id text NOT NULL,
  PRIMARY KEY(company_id,baseline_id,stock_item_id),
  UNIQUE(company_id,ledger_id),
  FOREIGN KEY(company_id,baseline_id)
    REFERENCES myfin.stock_baselines(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,ledger_id)
    REFERENCES myfin.stock_ledger(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX stock_baseline_items_stock_idx
  ON myfin.stock_baseline_items(company_id,stock_item_id,baseline_id);

CREATE FUNCTION myfin.protect_stock_baseline_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'stock_baseline_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_stock_baselines
  BEFORE UPDATE OR DELETE ON myfin.stock_baselines
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_stock_baseline_history();
CREATE TRIGGER immutable_stock_baseline_items
  BEFORE UPDATE OR DELETE ON myfin.stock_baseline_items
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_stock_baseline_history();
