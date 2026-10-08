-- Delivery is opt-in per company. Zones contain pricing and service promises;
-- no coordinates, geocoding provider data, or payment credentials are stored.
ALTER TABLE myfin.storefront_settings
  ADD COLUMN delivery_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE myfin.storefront_delivery_zones (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  fee_sen integer NOT NULL CHECK(fee_sen BETWEEN 0 AND 100000000),
  minimum_order_sen integer NOT NULL DEFAULT 0 CHECK(minimum_order_sen BETWEEN 0 AND 100000000),
  lead_time_minutes integer NOT NULL CHECK(lead_time_minutes BETWEEN 5 AND 1440),
  service_instructions text NOT NULL DEFAULT '' CHECK(length(service_instructions) <= 1000),
  enabled boolean NOT NULL DEFAULT false,
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id)
);
CREATE UNIQUE INDEX storefront_delivery_zones_name_key
  ON myfin.storefront_delivery_zones(company_id,lower(name));
CREATE INDEX storefront_delivery_zones_public_idx
  ON myfin.storefront_delivery_zones(company_id,created_at,id) WHERE enabled;

-- Existing pickup/table records remain nullable because older rows did not
-- persist whether a "both" location was used at its table or counter.
ALTER TABLE myfin.customer_order_requests
  ADD COLUMN service_mode text CHECK(service_mode IN ('pickup','table','delivery')),
  ADD COLUMN delivery_zone_id text,
  ADD COLUMN delivery_zone_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN delivery_address_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN delivery_contact_purpose text NOT NULL DEFAULT '',
  ADD COLUMN delivery_fee_sen integer NOT NULL DEFAULT 0 CHECK(delivery_fee_sen BETWEEN 0 AND 100000000),
  ADD COLUMN delivery_address_redacted_at timestamptz,
  ADD CONSTRAINT customer_order_delivery_zone_fk
    FOREIGN KEY(company_id,delivery_zone_id)
    REFERENCES myfin.storefront_delivery_zones(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT customer_order_delivery_shape CHECK (
    (service_mode='delivery' AND delivery_zone_id IS NOT NULL
      AND jsonb_typeof(delivery_zone_snapshot)='object' AND delivery_zone_snapshot<>'{}'::jsonb
      AND jsonb_typeof(delivery_address_snapshot)='object'
      AND delivery_contact_purpose IN ('order_delivery','')
      AND ((delivery_contact_purpose='order_delivery' AND delivery_address_redacted_at IS NULL
        AND length(btrim(coalesce(delivery_address_snapshot->>'addressLine1',''))) BETWEEN 1 AND 160
        AND length(btrim(coalesce(delivery_address_snapshot->>'postcode',''))) BETWEEN 2 AND 20
        AND length(btrim(coalesce(delivery_address_snapshot->>'city',''))) BETWEEN 1 AND 120
        AND length(btrim(coalesce(delivery_address_snapshot->>'state',''))) BETWEEN 1 AND 120
        AND coalesce(delivery_address_snapshot->>'countryCode','')='MY')
      OR (delivery_contact_purpose='' AND delivery_address_redacted_at IS NOT NULL
        AND delivery_address_snapshot='{}'::jsonb)))
    OR
    (service_mode IS DISTINCT FROM 'delivery' AND delivery_zone_id IS NULL
      AND delivery_zone_snapshot='{}'::jsonb AND delivery_address_snapshot='{}'::jsonb
      AND delivery_contact_purpose='' AND delivery_fee_sen=0
      AND delivery_address_redacted_at IS NULL)
  ),
  ADD CONSTRAINT customer_order_delivery_snapshot_size CHECK (
    length(delivery_zone_snapshot::text) <= 2500 AND
    length(delivery_address_snapshot::text) <= 5000
  ),
  ADD CONSTRAINT customer_order_delivery_total CHECK (
    service_mode IS DISTINCT FROM 'delivery' OR
    (total_before_rounding=subtotal-discount_amount+tax+(delivery_fee_sen::numeric/100)
      AND total=total_before_rounding+rounding)
  );

CREATE INDEX customer_order_delivery_queue_idx
  ON myfin.customer_order_requests(company_id,delivery_zone_id,status,created_at DESC)
  WHERE service_mode='delivery';

-- Fulfillment and pricing snapshots cannot be rewritten after submission.
-- The address can only make the one-way transition to an empty redacted value.
CREATE FUNCTION myfin.protect_customer_order_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.service_mode IS DISTINCT FROM OLD.service_mode OR
     NEW.delivery_zone_id IS DISTINCT FROM OLD.delivery_zone_id OR
     NEW.delivery_zone_snapshot IS DISTINCT FROM OLD.delivery_zone_snapshot OR
     NEW.delivery_fee_sen IS DISTINCT FROM OLD.delivery_fee_sen THEN
    RAISE EXCEPTION 'customer_order_delivery_snapshot_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.delivery_address_snapshot IS DISTINCT FROM OLD.delivery_address_snapshot OR
     NEW.delivery_contact_purpose IS DISTINCT FROM OLD.delivery_contact_purpose OR
     NEW.delivery_address_redacted_at IS DISTINCT FROM OLD.delivery_address_redacted_at THEN
    IF OLD.service_mode IS DISTINCT FROM 'delivery' OR OLD.delivery_address_redacted_at IS NOT NULL OR
       NEW.delivery_address_snapshot <> '{}'::jsonb OR NEW.delivery_contact_purpose <> '' OR
       NEW.delivery_address_redacted_at IS NULL OR NEW.pii_redacted_at IS NULL THEN
      RAISE EXCEPTION 'customer_order_delivery_address_immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_order_delivery_snapshot_guard
  BEFORE UPDATE OF service_mode,delivery_zone_id,delivery_zone_snapshot,delivery_fee_sen,
    delivery_address_snapshot,delivery_contact_purpose,delivery_address_redacted_at
  ON myfin.customer_order_requests
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_customer_order_delivery_snapshot();

REVOKE ALL ON TABLE myfin.storefront_delivery_zones FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_customer_order_delivery_snapshot() FROM PUBLIC;
