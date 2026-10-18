-- Reusable storefront media is immutable file content with editable, bounded metadata.
-- Public delivery is restricted to image assets and their unguessable file identifiers.

ALTER TABLE myfin.files
  DROP CONSTRAINT files_kind_check,
  DROP CONSTRAINT files_check,
  ADD COLUMN label text NOT NULL DEFAULT '' CHECK(length(label) <= 120),
  ADD COLUMN alt_text text NOT NULL DEFAULT '' CHECK(length(alt_text) <= 300),
  ADD CONSTRAINT files_kind_check CHECK(kind IN ('products','receipts','assets')),
  ADD CONSTRAINT files_product_limits_check CHECK(
    kind <> 'products' OR (size <= 3145728 AND mime <> 'application/pdf')
  ),
  ADD CONSTRAINT files_asset_mime_check CHECK(
    kind <> 'assets' OR mime IN ('image/jpeg','image/png','image/webp')
  );

ALTER TABLE myfin.storefront_settings
  DROP CONSTRAINT storefront_settings_logo_url_check,
  DROP CONSTRAINT storefront_settings_hero_image_url_check,
  ADD CONSTRAINT storefront_settings_logo_url_check CHECK(
    length(logo_url) <= 2048 AND (
      logo_url = '' OR logo_url ~ '^https://[^[:space:]]+$' OR
      logo_url ~ '^/api/public/storefront-assets/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  ),
  ADD CONSTRAINT storefront_settings_hero_image_url_check CHECK(
    length(hero_image_url) <= 2048 AND (
      hero_image_url = '' OR hero_image_url ~ '^https://[^[:space:]]+$' OR
      hero_image_url ~ '^/api/public/storefront-assets/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );

ALTER TABLE myfin.storefront_carousel_slides
  DROP CONSTRAINT storefront_carousel_slides_image_url_check,
  ADD CONSTRAINT storefront_carousel_slides_image_url_check CHECK(
    length(image_url) <= 2048 AND (
      image_url = '' OR image_url ~ '^https://[^[:space:]]+$' OR
      image_url ~ '^/api/public/storefront-assets/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );
