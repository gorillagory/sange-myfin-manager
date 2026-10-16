-- Storefront branding and online pricing are explicit company projections.
-- Every public text value is bounded, colors are strict hexadecimal values,
-- image links must use HTTPS, and online price overrides use exact integer sen.

ALTER TABLE myfin.storefront_settings
  ADD COLUMN logo_url text NOT NULL DEFAULT ''
    CHECK(length(logo_url) <= 2048 AND (logo_url='' OR logo_url ~ '^https://[^[:space:]]+$')),
  ADD COLUMN theme_primary_color text NOT NULL DEFAULT '#17624d'
    CHECK(theme_primary_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN theme_accent_color text NOT NULL DEFAULT '#d7a43b'
    CHECK(theme_accent_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN theme_background_color text NOT NULL DEFAULT '#fbfcf8'
    CHECK(theme_background_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN theme_text_color text NOT NULL DEFAULT '#15382c'
    CHECK(theme_text_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN theme_font_family text NOT NULL DEFAULT 'geist'
    CHECK(theme_font_family IN ('geist','system','serif')),
  ADD COLUMN hero_eyebrow text NOT NULL DEFAULT 'ORDER ONLINE'
    CHECK(length(hero_eyebrow) <= 80),
  ADD COLUMN hero_title text NOT NULL DEFAULT ''
    CHECK(length(hero_title) <= 160),
  ADD COLUMN hero_description text NOT NULL DEFAULT ''
    CHECK(length(hero_description) <= 1000),
  ADD COLUMN hero_image_url text NOT NULL DEFAULT ''
    CHECK(length(hero_image_url) <= 2048 AND
      (hero_image_url='' OR hero_image_url ~ '^https://[^[:space:]]+$')),
  ADD COLUMN carousel_interval_seconds integer NOT NULL DEFAULT 7
    CHECK(carousel_interval_seconds BETWEEN 3 AND 30);

CREATE TABLE myfin.storefront_carousel_slides (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  published boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN -1000000 AND 1000000),
  badge text NOT NULL DEFAULT '' CHECK(length(badge) <= 80),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 1000),
  image_url text NOT NULL DEFAULT '' CHECK(length(image_url) <= 2048 AND
    (image_url='' OR image_url ~ '^https://[^[:space:]]+$')),
  background_color text NOT NULL DEFAULT '#17624d'
    CHECK(background_color ~ '^#[0-9a-fA-F]{6}$'),
  cta_label text NOT NULL DEFAULT '' CHECK(length(cta_label) <= 60),
  cta_url text NOT NULL DEFAULT '' CHECK(length(cta_url) <= 2048 AND
    (cta_url='' OR cta_url ~ '^https://[^[:space:]]+$' OR
      (cta_url ~ '^/[A-Za-z0-9/_?&=.%#-]*$' AND cta_url !~ '^//'))),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  CHECK((cta_label='')=(cta_url=''))
);
CREATE INDEX storefront_carousel_public_idx
  ON myfin.storefront_carousel_slides(company_id,sort_order,id) WHERE published;

ALTER TABLE myfin.storefront_products
  ADD COLUMN online_price_sen integer
    CHECK(online_price_sen IS NULL OR online_price_sen BETWEEN 0 AND 100000000);

ALTER TABLE myfin.storefront_product_variants
  ADD COLUMN online_price_sen integer
    CHECK(online_price_sen IS NULL OR online_price_sen BETWEEN 0 AND 100000000);

REVOKE ALL ON myfin.storefront_carousel_slides FROM PUBLIC;
