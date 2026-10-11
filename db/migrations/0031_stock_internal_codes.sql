-- Give every operational stock item a stable tenant-local code. These codes
-- are generated while holding the existing company stock-write lock, and are
-- part of the same collision domain as physical barcodes and QR identifiers.

ALTER TABLE myfin.stock_items ADD COLUMN internal_code text;

-- Keep migration-first rolling deploys writable: the previous API does not
-- send this column. The trigger takes the same company lock as stock writes,
-- then skips codes already used by any scan-code source.
CREATE FUNCTION myfin.assign_stock_internal_code() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  sequence_value bigint;
  candidate text;
BEGIN
  IF NEW.internal_code IS NOT NULL AND btrim(NEW.internal_code)<>'' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id,9));
  SELECT coalesce(max(substring(internal_code FROM 5)::bigint)
    FILTER (WHERE internal_code ~ '^STK-[0-9]{6,18}$'),0)+1
    INTO sequence_value FROM myfin.stock_items WHERE company_id=NEW.company_id;
  LOOP
    candidate:='STK-'||lpad(sequence_value::text,6,'0');
    EXIT WHEN NOT EXISTS(
      SELECT 1 FROM myfin.stock_items s WHERE s.company_id=NEW.company_id AND
        (upper(btrim(s.barcode))=candidate OR upper(s.internal_code)=candidate)
      UNION ALL
      SELECT 1 FROM myfin.stock_packagings p
        WHERE p.company_id=NEW.company_id AND upper(btrim(p.barcode))=candidate
      UNION ALL
      SELECT 1 FROM myfin.stock_identifiers i
        WHERE i.company_id=NEW.company_id AND i.active AND i.normalized_value=candidate
    );
    sequence_value:=sequence_value+1;
  END LOOP;
  NEW.internal_code:=candidate;
  RETURN NEW;
END $$;
CREATE TRIGGER assign_stock_internal_code_before_insert
  BEFORE INSERT ON myfin.stock_items FOR EACH ROW
  EXECUTE FUNCTION myfin.assign_stock_internal_code();

DO $$
DECLARE
  company_row record;
  item_row record;
  sequence_value bigint;
  candidate text;
BEGIN
  FOR company_row IN SELECT DISTINCT company_id FROM myfin.stock_items ORDER BY company_id LOOP
    sequence_value:=0;
    FOR item_row IN SELECT id FROM myfin.stock_items
      WHERE company_id=company_row.company_id ORDER BY id LOOP
      LOOP
        sequence_value:=sequence_value+1;
        candidate:='STK-'||lpad(sequence_value::text,6,'0');
        EXIT WHEN NOT EXISTS(
          SELECT 1 FROM myfin.stock_items s
            WHERE s.company_id=company_row.company_id AND upper(btrim(s.barcode))=candidate
          UNION ALL
          SELECT 1 FROM myfin.stock_packagings p
            WHERE p.company_id=company_row.company_id AND upper(btrim(p.barcode))=candidate
          UNION ALL
          SELECT 1 FROM myfin.stock_identifiers i
            WHERE i.company_id=company_row.company_id AND i.active AND i.normalized_value=candidate
        );
      END LOOP;
      UPDATE myfin.stock_items SET internal_code=candidate
        WHERE company_id=company_row.company_id AND id=item_row.id;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE myfin.stock_items ALTER COLUMN internal_code SET NOT NULL;
ALTER TABLE myfin.stock_items ADD CONSTRAINT stock_items_internal_code_format
  CHECK(internal_code ~ '^STK-[0-9]{6,18}$');
CREATE UNIQUE INDEX stock_items_internal_code_key
  ON myfin.stock_items(company_id,upper(internal_code));

CREATE OR REPLACE FUNCTION myfin.enforce_scan_code_uniqueness() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  scan_code text;
  scan_codes text[];
  conflict boolean;
BEGIN
  IF TG_TABLE_NAME='stock_identifiers' THEN
    IF NOT NEW.active THEN RETURN NEW; END IF;
    scan_codes:=ARRAY[NEW.normalized_value];
  ELSIF TG_TABLE_NAME='stock_items' THEN
    IF btrim(NEW.barcode)<>'' AND upper(btrim(NEW.barcode))=upper(NEW.internal_code) THEN
      RAISE EXCEPTION 'duplicate_scan_code' USING ERRCODE='23505';
    END IF;
    scan_codes:=ARRAY[upper(btrim(NEW.barcode)),upper(NEW.internal_code)];
  ELSE
    scan_codes:=ARRAY[upper(btrim(NEW.barcode))];
  END IF;

  SELECT array_agg(code ORDER BY code) INTO scan_codes
    FROM (SELECT DISTINCT code FROM unnest(scan_codes) AS values_row(code)
      WHERE code<>'') unique_codes;
  FOREACH scan_code IN ARRAY coalesce(scan_codes,ARRAY[]::text[]) LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id||':scan-code:'||scan_code,35));
    IF TG_TABLE_NAME='stock_identifiers' THEN
      SELECT EXISTS(SELECT 1 FROM myfin.stock_items s
          WHERE s.company_id=NEW.company_id AND
            (upper(btrim(s.barcode))=scan_code OR upper(s.internal_code)=scan_code))
        OR EXISTS(SELECT 1 FROM myfin.stock_packagings p
          WHERE p.company_id=NEW.company_id AND upper(btrim(p.barcode))=scan_code)
        INTO conflict;
    ELSIF TG_TABLE_NAME='stock_items' THEN
      SELECT EXISTS(SELECT 1 FROM myfin.stock_identifiers i
          WHERE i.company_id=NEW.company_id AND i.active AND i.normalized_value=scan_code)
        OR EXISTS(SELECT 1 FROM myfin.stock_packagings p
          WHERE p.company_id=NEW.company_id AND upper(btrim(p.barcode))=scan_code)
        OR EXISTS(SELECT 1 FROM myfin.stock_items s
          WHERE s.company_id=NEW.company_id AND s.id<>NEW.id AND
            (upper(btrim(s.barcode))=scan_code OR upper(s.internal_code)=scan_code))
        INTO conflict;
    ELSE
      SELECT EXISTS(SELECT 1 FROM myfin.stock_identifiers i
          WHERE i.company_id=NEW.company_id AND i.active AND i.normalized_value=scan_code)
        OR EXISTS(SELECT 1 FROM myfin.stock_items s
          WHERE s.company_id=NEW.company_id AND
            (upper(btrim(s.barcode))=scan_code OR upper(s.internal_code)=scan_code))
        OR EXISTS(SELECT 1 FROM myfin.stock_packagings p
          WHERE p.company_id=NEW.company_id AND
            (p.item_id,p.id)<>(NEW.item_id,NEW.id) AND upper(btrim(p.barcode))=scan_code)
        INTO conflict;
    END IF;
    IF conflict THEN
      RAISE EXCEPTION 'duplicate_scan_code' USING ERRCODE='23505';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER scan_code_stock_item_update_guard ON myfin.stock_items;
CREATE TRIGGER scan_code_stock_item_update_guard
  BEFORE UPDATE OF company_id,barcode,internal_code ON myfin.stock_items
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_scan_code_uniqueness();

REVOKE ALL ON FUNCTION myfin.enforce_scan_code_uniqueness() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.assign_stock_internal_code() FROM PUBLIC;
