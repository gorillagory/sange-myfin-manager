-- Inventory is the catalogue of record for POS and online ordering. Storefront
-- rows now contain channel presentation/price state only; they no longer decide
-- whether a catalogue item exists on a selling surface.

ALTER TABLE myfin.storefront_products
  ADD COLUMN image_url text NOT NULL DEFAULT '',
  ADD CONSTRAINT storefront_products_image_url_check CHECK(
    length(image_url) <= 2048 AND (
      image_url = '' OR image_url ~ '^https://[^[:space:]]+$' OR
      image_url ~ '^/api/public/storefront-assets/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );

-- These nullable columns intentionally stay NULL on pre-migration immutable
-- snapshots. Every new snapshot records the catalogue price, product version,
-- and the channel rule that selected the actual unit price. That gives future
-- analytics a stable "sold at X while catalogue was Y" fact even after edits.
ALTER TABLE myfin.pricing_snapshot_lines
  ADD COLUMN catalog_unit_price_sen bigint,
  ADD COLUMN catalog_product_version bigint,
  ADD COLUMN price_source text,
  ADD CONSTRAINT pricing_snapshot_lines_catalog_evidence_check CHECK(
    (catalog_unit_price_sen IS NULL AND catalog_product_version IS NULL AND price_source IS NULL)
    OR (
      catalog_unit_price_sen IS NOT NULL AND
      catalog_product_version IS NOT NULL AND
      price_source IS NOT NULL AND
      catalog_unit_price_sen BETWEEN 0 AND 9000000000000000 AND
      catalog_product_version > 0 AND
      price_source IN ('catalog','online_override')
    )
  );

COMMENT ON COLUMN myfin.storefront_products.image_url IS
  'Optional online-only product image. Empty uses the inventory product image.';
COMMENT ON COLUMN myfin.pricing_snapshot_lines.catalog_unit_price_sen IS
  'Immutable catalogue price at quote time, before any channel override or promotion.';
COMMENT ON COLUMN myfin.pricing_snapshot_lines.catalog_product_version IS
  'Product catalogue version used to price this line.';
COMMENT ON COLUMN myfin.pricing_snapshot_lines.price_source IS
  'Rule that selected unit_price_sen: catalog or online_override.';
