-- Operational stores and internal locations are separate from public ordering
-- QR/service points.  Every existing company receives one safe default store
-- and front-counter location so later foreign keys can be introduced without
-- inventing historical device attribution.
ALTER TABLE myfin.companies
  ADD COLUMN terminal_enforcement_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN terminal_enforcement_from timestamptz,
  ADD COLUMN require_open_register_for_pos boolean NOT NULL DEFAULT false,
  ADD COLUMN require_open_register_from timestamptz;
ALTER TABLE myfin.companies ADD CONSTRAINT companies_terminal_enforcement_cutover CHECK(
  (terminal_enforcement_enabled AND terminal_enforcement_from IS NOT NULL) OR
  (NOT terminal_enforcement_enabled AND terminal_enforcement_from IS NULL));
ALTER TABLE myfin.companies ADD CONSTRAINT companies_open_register_requires_terminal
  CHECK(NOT require_open_register_for_pos OR terminal_enforcement_enabled);
ALTER TABLE myfin.companies ADD CONSTRAINT companies_open_register_cutover CHECK(
  (require_open_register_for_pos AND require_open_register_from IS NOT NULL) OR
  (NOT require_open_register_for_pos AND require_open_register_from IS NULL));

CREATE TABLE myfin.stores (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  code text NOT NULL CHECK(code=upper(code) AND code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  type text NOT NULL DEFAULT 'outlet' CHECK(type IN ('outlet','branch','kiosk','warehouse','office','pop_up')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
  time_zone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur' CHECK(length(time_zone) BETWEEN 1 AND 80),
  address jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(address)='object'),
  phone text NOT NULL DEFAULT '' CHECK(length(phone)<=80),
  email text NOT NULL DEFAULT '' CHECK(length(email)<=254),
  latitude numeric(9,6),
  longitude numeric(9,6),
  geofence_radius_m integer,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,code),
  CHECK((latitude IS NULL AND longitude IS NULL AND geofence_radius_m IS NULL) OR
    (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180 AND geofence_radius_m BETWEEN 10 AND 100000))
);

CREATE TABLE myfin.store_locations (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  store_id text NOT NULL,
  code text NOT NULL CHECK(code=upper(code) AND code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  type text NOT NULL DEFAULT 'front_counter' CHECK(type IN ('front_counter','kitchen','stockroom','office','service_area','other')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
  customer_facing boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,store_id,id),
  UNIQUE(company_id,store_id,code),
  FOREIGN KEY(company_id,store_id) REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT
);

INSERT INTO myfin.stores(company_id,id,code,name,type,address)
SELECT c.id,'store-'||md5(c.id),'MAIN',left(c.name,120),'outlet',
  CASE WHEN coalesce(c.data->>'address','')='' THEN '{}'::jsonb
       ELSE jsonb_build_object('formatted',c.data->>'address') END
FROM myfin.companies c;

INSERT INTO myfin.store_locations(company_id,id,store_id,code,name,type,customer_facing)
SELECT c.id,'location-'||md5(c.id),'store-'||md5(c.id),'COUNTER','Front counter','front_counter',true
FROM myfin.companies c;

CREATE INDEX stores_company_status_idx ON myfin.stores(company_id,status,name);
CREATE INDEX store_locations_store_status_idx ON myfin.store_locations(company_id,store_id,status,name);

-- shop_locations continue to mean public QR/table/pickup service points.  These
-- optional links merely tell the system which physical store/area serves one.
ALTER TABLE myfin.shop_locations
  ADD COLUMN store_id text,
  ADD COLUMN store_location_id text;
UPDATE myfin.shop_locations q SET
  store_id='store-'||md5(q.company_id),
  store_location_id='location-'||md5(q.company_id);
ALTER TABLE myfin.shop_locations
  ADD CONSTRAINT shop_locations_store_fk FOREIGN KEY(company_id,store_id)
    REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT shop_locations_store_location_fk FOREIGN KEY(company_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT shop_locations_store_area_fk FOREIGN KEY(company_id,store_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,store_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT shop_locations_store_location_shape CHECK(
    (store_id IS NULL AND store_location_id IS NULL) OR
    (store_id IS NOT NULL AND store_location_id IS NOT NULL));
