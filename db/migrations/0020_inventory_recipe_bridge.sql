-- Opt-in recipes bridge sellable products to the independent stock-room ledger.
-- Existing products keep their legacy catalog-stock behaviour until a recipe is
-- explicitly enabled. Recipe history and source effects are append-only.

CREATE TABLE myfin.inventory_recipes (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  product_id text NOT NULL,
  variant_id text,
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES myfin.products(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id,variant_id)
    REFERENCES myfin.product_variants(company_id,product_id,id) ON DELETE RESTRICT,
  CHECK(variant_id IS NULL OR length(variant_id) BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX inventory_recipes_target_key
  ON myfin.inventory_recipes(company_id,product_id,coalesce(variant_id,''));

CREATE TABLE myfin.inventory_recipe_versions (
  company_id text NOT NULL,
  recipe_id text NOT NULL,
  version bigint NOT NULL CHECK(version > 0),
  enabled boolean NOT NULL,
  catalog_stock_disabled boolean NOT NULL,
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,recipe_id,version),
  FOREIGN KEY(company_id,recipe_id)
    REFERENCES myfin.inventory_recipes(company_id,id) ON DELETE RESTRICT,
  CHECK(NOT enabled OR catalog_stock_disabled)
);

CREATE TABLE myfin.inventory_recipe_components (
  company_id text NOT NULL,
  recipe_id text NOT NULL,
  recipe_version bigint NOT NULL,
  stock_item_id text NOT NULL,
  position integer NOT NULL CHECK(position BETWEEN 0 AND 99),
  quantity_per_unit numeric(18,6) NOT NULL
    CHECK(quantity_per_unit > 0 AND quantity_per_unit <= 1000000000000),
  PRIMARY KEY(company_id,recipe_id,recipe_version,stock_item_id),
  UNIQUE(company_id,recipe_id,recipe_version,position),
  FOREIGN KEY(company_id,recipe_id,recipe_version)
    REFERENCES myfin.inventory_recipe_versions(company_id,recipe_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,stock_item_id)
    REFERENCES myfin.stock_items(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX inventory_recipe_components_stock_idx
  ON myfin.inventory_recipe_components(company_id,stock_item_id,recipe_id,recipe_version);

CREATE FUNCTION myfin.protect_inventory_recipe_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'inventory_recipe_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_inventory_recipe_versions
  BEFORE UPDATE OR DELETE ON myfin.inventory_recipe_versions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_inventory_recipe_history();
CREATE TRIGGER immutable_inventory_recipe_components
  BEFORE UPDATE OR DELETE ON myfin.inventory_recipe_components
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_inventory_recipe_history();

-- Match the checkout adapter exactly, including legacy records where
-- trackStock is absent and stock/variant stock implies tracking.
CREATE FUNCTION myfin.product_uses_catalog_stock(product_data jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,myfin AS $$
  SELECT coalesce(product_data->>'category','') <> 'Service' AND CASE
    WHEN jsonb_typeof(product_data->'trackStock')='boolean'
      THEN (product_data->>'trackStock')::boolean
    ELSE (product_data ? 'stock' AND jsonb_typeof(product_data->'stock') <> 'null') OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(product_data->'variants')='array'
        THEN product_data->'variants' ELSE '[]'::jsonb END) AS variants(value)
      WHERE value ? 'stock' AND jsonb_typeof(value->'stock') <> 'null'
    )
  END
$$;

-- An enabled recipe replaces legacy product-stock deduction for its target.
-- Guard both sides, including recipe history: an offline sale uses the recipe
-- version effective when it occurred, so a product cannot later return to
-- catalog tracking without risking two deductions when that sale synchronizes.
CREATE FUNCTION myfin.enforce_recipe_catalog_stock() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE product_data jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.product_id IS DISTINCT FROM OLD.product_id OR
    NEW.variant_id IS DISTINCT FROM OLD.variant_id
  ) THEN
    RAISE EXCEPTION 'inventory_recipe_target_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.enabled THEN
    SELECT data INTO product_data FROM myfin.products
      WHERE company_id=NEW.company_id AND id=NEW.product_id;
    IF myfin.product_uses_catalog_stock(product_data) THEN
      RAISE EXCEPTION 'recipe_requires_catalog_stock_disabled' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_recipe_catalog_stock_guard
  BEFORE INSERT OR UPDATE OF enabled,product_id,variant_id ON myfin.inventory_recipes
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_recipe_catalog_stock();

CREATE FUNCTION myfin.enforce_product_recipe_mode() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF myfin.product_uses_catalog_stock(NEW.data) AND EXISTS(
    SELECT 1 FROM myfin.inventory_recipes r
    JOIN myfin.inventory_recipe_versions rv
      ON rv.company_id=r.company_id AND rv.recipe_id=r.id
    WHERE r.company_id=NEW.company_id AND r.product_id=NEW.id AND rv.enabled
  ) THEN
    RAISE EXCEPTION 'enabled_recipe_prevents_catalog_stock' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_recipe_mode_guard
  BEFORE INSERT OR UPDATE OF data ON myfin.products
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_product_recipe_mode();

CREATE FUNCTION myfin.protect_enabled_recipe_stock() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF OLD.active AND NOT NEW.active AND EXISTS(
    SELECT 1 FROM myfin.inventory_recipes r
    JOIN myfin.inventory_recipe_components c
      ON c.company_id=r.company_id AND c.recipe_id=r.id AND c.recipe_version=r.version
    WHERE r.company_id=NEW.company_id AND r.enabled AND c.stock_item_id=NEW.id
  ) THEN
    RAISE EXCEPTION 'stock_item_used_by_enabled_recipe' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enabled_recipe_stock_guard
  BEFORE UPDATE OF active ON myfin.stock_items
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_enabled_recipe_stock();

-- A source marker makes even a sale with no configured recipe exactly-once.
CREATE TABLE myfin.inventory_source_effects (
  company_id text NOT NULL,
  source_type text NOT NULL CHECK(source_type IN ('pos_sale')),
  source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,source_type,source_id),
  FOREIGN KEY(company_id,source_id) REFERENCES myfin.transactions(company_id,id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER immutable_inventory_source_effects
  BEFORE UPDATE OR DELETE ON myfin.inventory_source_effects
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_inventory_recipe_history();

ALTER TABLE myfin.stock_ledger ADD COLUMN source_type text;
ALTER TABLE myfin.stock_ledger ADD COLUMN source_id text;
ALTER TABLE myfin.stock_ledger ADD COLUMN source_details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE myfin.stock_ledger ADD CONSTRAINT stock_ledger_source_pair
  CHECK((source_type IS NULL)=(source_id IS NULL));
ALTER TABLE myfin.stock_ledger ADD CONSTRAINT stock_ledger_source_type
  CHECK(source_type IS NULL OR source_type IN ('pos_sale'));
ALTER TABLE myfin.stock_ledger ADD CONSTRAINT stock_ledger_source_id_length
  CHECK(source_id IS NULL OR length(source_id) BETWEEN 1 AND 128);
ALTER TABLE myfin.stock_ledger ADD CONSTRAINT stock_ledger_source_details_object
  CHECK(jsonb_typeof(source_details)='object');
ALTER TABLE myfin.stock_ledger ADD CONSTRAINT stock_ledger_source_transaction_fk
  FOREIGN KEY(company_id,source_id) REFERENCES myfin.transactions(company_id,id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX stock_ledger_source_item_key
  ON myfin.stock_ledger(company_id,source_type,source_id,item_id)
  WHERE source_type IS NOT NULL;
