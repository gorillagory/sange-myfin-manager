-- Preserve the unit in which every stock fact was recorded, while allowing an
-- owner to correct a stock item's current measurement without rewriting the
-- immutable movement ledger.

ALTER TABLE myfin.stock_items
  ADD COLUMN unit_version bigint NOT NULL DEFAULT 1 CHECK(unit_version > 0);

-- Keep generated labels monotonic even after an unused item is permanently
-- purged. Reusing a printed STK code could make an old label identify a new
-- item, so the counter deliberately outlives stock_items rows.
CREATE TABLE myfin.stock_internal_code_counters (
  company_id text PRIMARY KEY REFERENCES myfin.companies(id) ON DELETE CASCADE,
  last_value bigint NOT NULL CHECK(last_value > 0)
);
INSERT INTO myfin.stock_internal_code_counters(company_id,last_value)
SELECT company_id,max(substring(internal_code FROM 5)::bigint)
  FROM myfin.stock_items
 WHERE internal_code ~ '^STK-[0-9]{6,18}$'
 GROUP BY company_id;

CREATE OR REPLACE FUNCTION myfin.assign_stock_internal_code() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE sequence_value bigint; candidate text;
BEGIN
  IF NEW.internal_code IS NOT NULL AND btrim(NEW.internal_code)<>'' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id,9));
  FOR attempt IN 1..1000 LOOP
    INSERT INTO myfin.stock_internal_code_counters(company_id,last_value)
      VALUES(NEW.company_id,1)
      ON CONFLICT(company_id) DO UPDATE
        SET last_value=myfin.stock_internal_code_counters.last_value+1
      RETURNING last_value INTO sequence_value;
    candidate:='STK-'||lpad(sequence_value::text,6,'0');
    EXIT WHEN NOT EXISTS(SELECT 1 FROM myfin.stock_items s WHERE s.company_id=NEW.company_id AND
      (upper(btrim(s.barcode))=candidate OR upper(s.internal_code)=candidate))
      AND NOT EXISTS(SELECT 1 FROM myfin.stock_packagings p WHERE p.company_id=NEW.company_id AND upper(btrim(p.barcode))=candidate)
      AND NOT EXISTS(SELECT 1 FROM myfin.stock_identifiers i WHERE i.company_id=NEW.company_id AND i.active AND i.normalized_value=candidate);
    candidate:=NULL;
  END LOOP;
  IF candidate IS NULL THEN RAISE EXCEPTION 'stock_internal_code_exhausted' USING ERRCODE='23514'; END IF;
  NEW.internal_code:=candidate;
  RETURN NEW;
END $$;

ALTER TABLE myfin.stock_ledger
  ADD COLUMN tracking_mode_at_time text,
  ADD COLUMN base_unit_at_time text,
  ADD COLUMN unit_version_at_time bigint,
  ADD COLUMN packaging_label_at_time text,
  ADD COLUMN packaging_quantity_at_time numeric(18,6);

-- The ledger guard predates these snapshot columns. Recreate it around the
-- one-time backfill so application writes remain append-only.
DROP TRIGGER immutable_stock_ledger ON myfin.stock_ledger;
UPDATE myfin.stock_ledger ledger
   SET tracking_mode_at_time=item.tracking_mode,
       base_unit_at_time=item.base_unit,
       unit_version_at_time=item.unit_version,
       packaging_label_at_time=(SELECT packaging.label FROM myfin.stock_packagings packaging
         WHERE packaging.company_id=ledger.company_id AND packaging.item_id=ledger.item_id
           AND packaging.id=ledger.packaging_id),
       packaging_quantity_at_time=(SELECT packaging.quantity_in_base FROM myfin.stock_packagings packaging
         WHERE packaging.company_id=ledger.company_id AND packaging.item_id=ledger.item_id
           AND packaging.id=ledger.packaging_id)
  FROM myfin.stock_items item
 WHERE item.company_id=ledger.company_id AND item.id=ledger.item_id;
ALTER TABLE myfin.stock_ledger
  ALTER COLUMN tracking_mode_at_time SET NOT NULL,
  ALTER COLUMN base_unit_at_time SET NOT NULL,
  ALTER COLUMN unit_version_at_time SET NOT NULL,
  ADD CONSTRAINT stock_ledger_tracking_snapshot_check
    CHECK(tracking_mode_at_time IN ('count','weight','volume')),
  ADD CONSTRAINT stock_ledger_unit_snapshot_check
    CHECK(length(btrim(base_unit_at_time)) BETWEEN 1 AND 32),
  ADD CONSTRAINT stock_ledger_unit_version_snapshot_check
    CHECK(unit_version_at_time > 0),
  ADD CONSTRAINT stock_ledger_packaging_snapshot_check CHECK(
    (packaging_id IS NULL AND packaging_label_at_time IS NULL AND packaging_quantity_at_time IS NULL)
    OR
    (packaging_id IS NOT NULL AND packaging_label_at_time IS NOT NULL
      AND packaging_quantity_at_time IS NOT NULL
      AND length(btrim(packaging_label_at_time)) BETWEEN 1 AND 120
      AND packaging_quantity_at_time > 0)
  );
CREATE TRIGGER immutable_stock_ledger BEFORE UPDATE OR DELETE ON myfin.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_stock_ledger();

CREATE FUNCTION myfin.snapshot_stock_ledger_unit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE item_row record; packaging_row record;
BEGIN
  SELECT tracking_mode,base_unit,unit_version INTO item_row
    FROM myfin.stock_items
   WHERE company_id=NEW.company_id AND id=NEW.item_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock_item_not_found' USING ERRCODE='23503';
  END IF;
  NEW.tracking_mode_at_time:=item_row.tracking_mode;
  NEW.base_unit_at_time:=item_row.base_unit;
  NEW.unit_version_at_time:=item_row.unit_version;
  IF NEW.packaging_id IS NOT NULL THEN
    SELECT label,quantity_in_base INTO packaging_row
      FROM myfin.stock_packagings
     WHERE company_id=NEW.company_id AND item_id=NEW.item_id AND id=NEW.packaging_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock_packaging_not_found' USING ERRCODE='23503';
    END IF;
    NEW.packaging_label_at_time:=packaging_row.label;
    NEW.packaging_quantity_at_time:=packaging_row.quantity_in_base;
  ELSE
    NEW.packaging_label_at_time:=NULL;
    NEW.packaging_quantity_at_time:=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_stock_ledger_unit_before_insert
  BEFORE INSERT ON myfin.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION myfin.snapshot_stock_ledger_unit();

CREATE TABLE myfin.stock_unit_corrections (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  stock_item_id text NOT NULL,
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  from_tracking_mode text NOT NULL CHECK(from_tracking_mode IN ('count','weight','volume')),
  from_base_unit text NOT NULL CHECK(length(btrim(from_base_unit)) BETWEEN 1 AND 32),
  from_unit_version bigint NOT NULL CHECK(from_unit_version > 0),
  to_tracking_mode text NOT NULL CHECK(to_tracking_mode IN ('count','weight','volume')),
  to_base_unit text NOT NULL CHECK(length(btrim(to_base_unit)) BETWEEN 1 AND 32),
  to_unit_version bigint NOT NULL CHECK(to_unit_version > 1),
  strategy text NOT NULL CHECK(strategy IN ('relabel','convert')),
  conversion_factor numeric(19,9) NOT NULL CHECK(conversion_factor > 0 AND conversion_factor <= 1000000000),
  on_hand_before numeric(18,6) NOT NULL CHECK(on_hand_before BETWEEN 0 AND 1000000000000),
  on_hand_after numeric(18,6) NOT NULL CHECK(on_hand_after BETWEEN 0 AND 1000000000000),
  reorder_level_before numeric(18,6) NOT NULL CHECK(reorder_level_before BETWEEN 0 AND 1000000000000),
  reorder_level_after numeric(18,6) NOT NULL CHECK(reorder_level_after BETWEEN 0 AND 1000000000000),
  packagings_before jsonb NOT NULL CHECK(jsonb_typeof(packagings_before)='array'),
  packagings_after jsonb NOT NULL CHECK(jsonb_typeof(packagings_after)='array'),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT stock_unit_corrections_from_version_key
    UNIQUE(company_id,stock_item_id,from_unit_version),
  CONSTRAINT stock_unit_corrections_to_version_key
    UNIQUE(company_id,stock_item_id,to_unit_version),
  CHECK(to_unit_version=from_unit_version+1),
  CHECK(jsonb_array_length(packagings_before)=jsonb_array_length(packagings_after)),
  CHECK((strategy='relabel' AND conversion_factor=1) OR strategy='convert'),
  CHECK(from_tracking_mode<>to_tracking_mode OR from_base_unit<>to_base_unit)
);
CREATE INDEX stock_unit_corrections_item_date_idx
  ON myfin.stock_unit_corrections(company_id,stock_item_id,created_at DESC,id DESC);

CREATE FUNCTION myfin.protect_stock_unit_correction() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'stock_unit_correction_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_stock_unit_corrections
  BEFORE UPDATE OR DELETE ON myfin.stock_unit_corrections
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_stock_unit_correction();

REVOKE ALL ON FUNCTION myfin.snapshot_stock_ledger_unit() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_stock_unit_correction() FROM PUBLIC;
