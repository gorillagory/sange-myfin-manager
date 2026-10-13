-- Fixed expense payment lifecycle, payer evidence and tenant-checked links to
-- inventory and procurement records. Historical rows keep their prior cash
-- treatment by starting as paid with an explicit legacy/unspecified payer.

ALTER TABLE myfin.expenses ADD COLUMN amount_sen bigint;
ALTER TABLE myfin.expenses ADD COLUMN status text NOT NULL DEFAULT 'paid';
ALTER TABLE myfin.expenses ADD COLUMN paid_by_type text NOT NULL DEFAULT 'legacy_unspecified';
ALTER TABLE myfin.expenses ADD COLUMN paid_by_identity_id text
  REFERENCES myfin.app_identities(id) ON DELETE RESTRICT;
ALTER TABLE myfin.expenses ADD COLUMN paid_by_name text;
ALTER TABLE myfin.expenses ADD COLUMN credit_terms_days integer;
ALTER TABLE myfin.expenses ADD COLUMN credit_due_date date;
ALTER TABLE myfin.expenses ADD COLUMN paid_on date;
ALTER TABLE myfin.expenses ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE myfin.expenses ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION myfin.valid_expense_date(value text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,myfin AS $$
DECLARE parsed date;
BEGIN
  IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN NULL; END IF;
  BEGIN parsed:=value::date; EXCEPTION WHEN others THEN RETURN NULL; END;
  IF to_char(parsed,'YYYY-MM-DD')<>value THEN RETURN NULL; END IF;
  RETURN parsed;
END $$;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM myfin.expenses WHERE myfin.valid_expense_date(data->>'date') IS NULL) THEN
    RAISE EXCEPTION 'invalid_existing_expense_date';
  END IF;
END $$;
UPDATE myfin.expenses SET amount_sen=round(amount*100)::bigint,
  paid_on=myfin.valid_expense_date(data->>'date');
ALTER TABLE myfin.expenses ALTER COLUMN amount_sen SET NOT NULL;
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_amount_sen_matches
  CHECK(amount_sen=round(amount*100)::bigint);
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_amount_sen_range
  CHECK(amount_sen BETWEEN 0 AND 100000000000000);
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_status_type
  CHECK(status IN ('pending','paid'));
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_paid_by_type
  CHECK(paid_by_type IN ('legacy_unspecified','app_user','non_user','petty_cash','other','credit'));
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_paid_by_user_shape
  CHECK((paid_by_type='app_user')=(paid_by_identity_id IS NOT NULL));
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_paid_by_name_shape
  CHECK((paid_by_name IS NULL OR length(paid_by_name)<=500)
    AND (paid_by_type NOT IN ('non_user','other')
      OR (paid_by_name IS NOT NULL AND length(btrim(paid_by_name)) BETWEEN 1 AND 500)));
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_credit_shape CHECK(
  (paid_by_type='credit' AND credit_due_date IS NOT NULL AND credit_terms_days IS NOT NULL
    AND credit_terms_days BETWEEN 1 AND 3650
    AND data->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
    AND credit_due_date=(data->>'date')::date+credit_terms_days)
  OR (paid_by_type<>'credit' AND credit_due_date IS NULL AND credit_terms_days IS NULL)
);
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_pending_is_credit
  CHECK(status='paid' OR paid_by_type='credit');
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_paid_on_shape
  CHECK((status='pending' AND paid_on IS NULL) OR (status='paid' AND paid_on IS NOT NULL));
ALTER TABLE myfin.expenses ADD CONSTRAINT expense_version_positive CHECK(version>0);
CREATE INDEX expenses_status_due_idx
  ON myfin.expenses(company_id,status,credit_due_date,id) WHERE voided_at IS NULL;
CREATE INDEX expenses_paid_by_identity_idx
  ON myfin.expenses(company_id,paid_by_identity_id,id) WHERE paid_by_identity_id IS NOT NULL;

-- Canonical JSON remains compatible with the document-shaped API while typed
-- columns provide enforceable reporting and joins. The trigger also keeps the
-- previous API writable during a migration-first rolling deployment.
CREATE FUNCTION myfin.sync_expense_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.status='paid' AND NEW.paid_on IS NULL THEN
    NEW.paid_on:=myfin.valid_expense_date(NEW.data->>'date');
  END IF;
  IF NEW.status='paid' AND NEW.paid_on IS NULL THEN
    RAISE EXCEPTION 'invalid_expense_paid_on' USING ERRCODE='23514';
  END IF;
  NEW.amount_sen:=round(NEW.amount*100)::bigint;
  NEW.data:=NEW.data || jsonb_build_object(
    'amount',NEW.amount,
    'status',NEW.status,
    'paidByType',NEW.paid_by_type,
    'paidByUserId',coalesce(NEW.paid_by_identity_id,''),
    'paidByName',coalesce(NEW.paid_by_name,''),
    'creditTermsDays',NEW.credit_terms_days,
    'creditDueDate',coalesce(NEW.credit_due_date::text,''),
    'paidOn',coalesce(NEW.paid_on::text,'')
  );
  IF TG_OP='UPDATE' THEN
    NEW.version:=OLD.version+1;
    NEW.updated_at:=now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_expense_lifecycle_before_write
  BEFORE INSERT OR UPDATE OF amount,data,status,paid_by_type,paid_by_identity_id,
    paid_by_name,credit_terms_days,credit_due_date,paid_on,voided_at,voided_by,void_reason ON myfin.expenses
  FOR EACH ROW EXECUTE FUNCTION myfin.sync_expense_lifecycle();

CREATE TABLE myfin.expense_links (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  expense_id text NOT NULL,
  link_type text NOT NULL CHECK(link_type IN
    ('stock_item','stock_movement','purchase_order','goods_receipt')),
  stock_item_id text,
  stock_ledger_id text,
  purchase_order_id text,
  goods_receipt_id text,
  source text NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','stock_ledger')),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,expense_id)
    REFERENCES myfin.expenses(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,stock_ledger_id)
    REFERENCES myfin.stock_ledger(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,purchase_order_id)
    REFERENCES myfin.purchase_orders(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,goods_receipt_id)
    REFERENCES myfin.goods_receipts(company_id,id) ON DELETE RESTRICT,
  CHECK(
    (link_type='stock_item' AND stock_item_id IS NOT NULL AND stock_ledger_id IS NULL AND purchase_order_id IS NULL AND goods_receipt_id IS NULL)
    OR (link_type='stock_movement' AND stock_item_id IS NULL AND stock_ledger_id IS NOT NULL AND purchase_order_id IS NULL AND goods_receipt_id IS NULL)
    OR (link_type='purchase_order' AND stock_item_id IS NULL AND stock_ledger_id IS NULL AND purchase_order_id IS NOT NULL AND goods_receipt_id IS NULL)
    OR (link_type='goods_receipt' AND stock_item_id IS NULL AND stock_ledger_id IS NULL AND purchase_order_id IS NULL AND goods_receipt_id IS NOT NULL)
  ),
  CHECK(source<>'stock_ledger' OR link_type='stock_movement')
);
CREATE INDEX expense_links_expense_idx ON myfin.expense_links(company_id,expense_id,link_type,id);
CREATE UNIQUE INDEX expense_links_stock_item_key
  ON myfin.expense_links(company_id,expense_id,stock_item_id) WHERE stock_item_id IS NOT NULL;
CREATE UNIQUE INDEX expense_links_stock_ledger_key
  ON myfin.expense_links(company_id,expense_id,stock_ledger_id) WHERE stock_ledger_id IS NOT NULL;
CREATE UNIQUE INDEX expense_links_purchase_order_key
  ON myfin.expense_links(company_id,expense_id,purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE UNIQUE INDEX expense_links_goods_receipt_key
  ON myfin.expense_links(company_id,expense_id,goods_receipt_id) WHERE goods_receipt_id IS NOT NULL;

CREATE TABLE myfin.expense_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  expense_id text NOT NULL,
  expense_version bigint NOT NULL CHECK(expense_version>0),
  action text NOT NULL CHECK(action IN ('created','updated','settled','voided','imported')),
  from_lifecycle jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(from_lifecycle)='object'),
  to_lifecycle jsonb NOT NULL CHECK(jsonb_typeof(to_lifecycle)='object'),
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,expense_id,expense_version),
  FOREIGN KEY(company_id,expense_id)
    REFERENCES myfin.expenses(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX expense_events_expense_version_idx
  ON myfin.expense_events(company_id,expense_id,expense_version,created_at,id);

CREATE FUNCTION myfin.protect_expense_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'expense_event_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_expense_event
  BEFORE UPDATE OR DELETE ON myfin.expense_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_expense_event();

INSERT INTO myfin.expense_links(company_id,id,expense_id,link_type,stock_ledger_id,source,created_by,created_at)
SELECT company_id,'expense-stock-'||md5(company_id||':'||id),expense_id,'stock_movement',id,
  'stock_ledger',actor_id,created_at
FROM myfin.stock_ledger WHERE expense_id IS NOT NULL;

CREATE FUNCTION myfin.link_stock_ledger_expense() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.expense_id IS NOT NULL THEN
    INSERT INTO myfin.expense_links(company_id,id,expense_id,link_type,stock_ledger_id,source,created_by,created_at)
    VALUES(NEW.company_id,'expense-stock-'||md5(NEW.company_id||':'||NEW.id),NEW.expense_id,
      'stock_movement',NEW.id,'stock_ledger',NEW.actor_id,NEW.created_at)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_ledger_expense_link_after_insert
  AFTER INSERT ON myfin.stock_ledger FOR EACH ROW EXECUTE FUNCTION myfin.link_stock_ledger_expense();

CREATE FUNCTION myfin.protect_expense_link_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF OLD.source='stock_ledger' THEN
    RAISE EXCEPTION 'expense_link_evidence_immutable' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER immutable_expense_link_evidence
  BEFORE UPDATE OR DELETE ON myfin.expense_links
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_expense_link_evidence();

REVOKE ALL ON FUNCTION myfin.sync_expense_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.valid_expense_date(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.link_stock_ledger_expense() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_expense_link_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_expense_event() FROM PUBLIC;
