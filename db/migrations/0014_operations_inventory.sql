-- Supplier-linked expense imports and a stock-room ledger independent of POS products.
ALTER TABLE myfin.expenses ADD COLUMN supplier_id text;
ALTER TABLE myfin.expenses ADD CONSTRAINT expenses_supplier_fk
  FOREIGN KEY(company_id,supplier_id) REFERENCES myfin.clients(company_id,id) ON DELETE RESTRICT;
CREATE INDEX expenses_supplier_idx ON myfin.expenses(company_id,supplier_id) WHERE supplier_id IS NOT NULL;

CREATE TABLE myfin.expense_import_batches (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  batch_id text NOT NULL CHECK(length(batch_id) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  imported_count integer NOT NULL CHECK(imported_count BETWEEN 1 AND 500),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,batch_id)
);

CREATE TABLE myfin.stock_items (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  category text NOT NULL DEFAULT 'General' CHECK(length(category) <= 120),
  tracking_mode text NOT NULL CHECK(tracking_mode IN ('count','weight','volume')),
  base_unit text NOT NULL CHECK(length(btrim(base_unit)) BETWEEN 1 AND 32),
  barcode text NOT NULL DEFAULT '' CHECK(length(barcode) <= 128),
  on_hand numeric(18,6) NOT NULL DEFAULT 0 CHECK(on_hand BETWEEN 0 AND 1000000000000),
  reorder_level numeric(18,6) NOT NULL DEFAULT 0 CHECK(reorder_level BETWEEN 0 AND 1000000000000),
  preferred_supplier_id text,
  active boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '' CHECK(length(notes) <= 10000),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  CONSTRAINT stock_items_supplier_fk FOREIGN KEY(company_id,preferred_supplier_id)
    REFERENCES myfin.clients(company_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX stock_items_barcode_key ON myfin.stock_items(company_id,upper(barcode)) WHERE barcode <> '';

CREATE TABLE myfin.stock_packagings (
  company_id text NOT NULL,
  item_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 120),
  barcode text NOT NULL DEFAULT '' CHECK(length(barcode) <= 128),
  quantity_in_base numeric(18,6) NOT NULL CHECK(quantity_in_base > 0 AND quantity_in_base <= 1000000000000),
  PRIMARY KEY(company_id,item_id,id),
  CONSTRAINT stock_packagings_item_fk FOREIGN KEY(company_id,item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX stock_packagings_barcode_key ON myfin.stock_packagings(company_id,upper(barcode)) WHERE barcode <> '';

CREATE TABLE myfin.stock_ledger (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  item_id text NOT NULL,
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('receive','count','adjust','consume','waste')),
  input_quantity numeric(18,6) NOT NULL CHECK(input_quantity BETWEEN -1000000000000 AND 1000000000000),
  delta numeric(18,6) NOT NULL CHECK(delta BETWEEN -1000000000000 AND 1000000000000),
  quantity_after numeric(18,6) NOT NULL CHECK(quantity_after BETWEEN 0 AND 1000000000000),
  packaging_id text,
  supplier_id text,
  expense_id text,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  CONSTRAINT stock_ledger_item_fk FOREIGN KEY(company_id,item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT stock_ledger_packaging_fk FOREIGN KEY(company_id,item_id,packaging_id)
    REFERENCES myfin.stock_packagings(company_id,item_id,id) ON DELETE RESTRICT,
  CONSTRAINT stock_ledger_supplier_fk FOREIGN KEY(company_id,supplier_id)
    REFERENCES myfin.clients(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT stock_ledger_expense_fk FOREIGN KEY(company_id,expense_id)
    REFERENCES myfin.expenses(company_id,id) ON DELETE RESTRICT,
  UNIQUE(company_id,idempotency_key)
);
CREATE INDEX stock_ledger_item_date_idx ON myfin.stock_ledger(company_id,item_id,created_at DESC);
CREATE INDEX stock_ledger_expense_idx ON myfin.stock_ledger(company_id,expense_id) WHERE expense_id IS NOT NULL;

CREATE FUNCTION myfin.protect_stock_ledger() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_stock_ledger BEFORE UPDATE OR DELETE ON myfin.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_stock_ledger();
