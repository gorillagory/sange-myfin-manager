-- Public ordering is deliberately separate from staff identities, staff hosts and
-- paid-sale fulfillment. Public catalog rows are opt-in projections.
CREATE TABLE myfin.storefront_settings (
  company_id text PRIMARY KEY REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  published boolean NOT NULL DEFAULT false,
  display_name text NOT NULL DEFAULT '' CHECK(length(display_name) <= 120),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  pickup_instructions text NOT NULL DEFAULT '' CHECK(length(pickup_instructions) <= 2000),
  order_expiry_minutes integer NOT NULL DEFAULT 30 CHECK(order_expiry_minutes BETWEEN 5 AND 1440),
  max_order_items integer NOT NULL DEFAULT 30 CHECK(max_order_items BETWEEN 1 AND 100),
  max_item_quantity numeric(12,3) NOT NULL DEFAULT 20 CHECK(max_item_quantity BETWEEN 0.001 AND 1000),
  max_order_value numeric(18,2) NOT NULL DEFAULT 1000 CHECK(max_order_value BETWEEN 0.01 AND 1000000),
  guest_data_retention_days integer NOT NULL DEFAULT 90 CHECK(guest_data_retention_days BETWEEN 7 AND 3650),
  privacy_controller_name text NOT NULL DEFAULT '' CHECK(length(privacy_controller_name) <= 160),
  privacy_controller_contact text NOT NULL DEFAULT '' CHECK(length(privacy_controller_contact) <= 254),
  privacy_notice_url text NOT NULL DEFAULT '' CHECK(length(privacy_notice_url) <= 2048 AND
    (privacy_notice_url='' OR privacy_notice_url ~ '^https://[^[:space:]]+$')),
  privacy_notice_en text NOT NULL DEFAULT '' CHECK(length(privacy_notice_en) <= 2000),
  privacy_notice_ms text NOT NULL DEFAULT '' CHECK(length(privacy_notice_ms) <= 2000),
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE myfin.storefront_hosts (
  hostname text PRIMARY KEY CHECK(hostname=lower(hostname) AND hostname ~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$'
    AND split_part(hostname,'.',1) LIKE 'order-%'),
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  disabled_at timestamptz,
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX storefront_hosts_company_active_key ON myfin.storefront_hosts(company_id)
  WHERE disabled_at IS NULL;

-- A hostname is one security surface. Serialize registrations across both
-- tables so a staff host can never shadow a public storefront (or vice versa).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM myfin.tenant_hosts t JOIN myfin.storefront_hosts s USING(hostname)) THEN
    RAISE EXCEPTION 'storefront_host_conflicts_with_staff_host';
  END IF;
END $$;
CREATE FUNCTION myfin.enforce_host_surface() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.hostname,18));
  IF TG_TABLE_NAME='tenant_hosts' THEN
    IF split_part(NEW.hostname,'.',1) LIKE 'order-%' OR
       EXISTS (SELECT 1 FROM myfin.storefront_hosts WHERE hostname=NEW.hostname) THEN
      RAISE EXCEPTION 'hostname_reserved_for_storefront' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM myfin.tenant_hosts WHERE hostname=NEW.hostname) THEN
    RAISE EXCEPTION 'hostname_already_used_by_staff' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_host_surface_guard BEFORE INSERT OR UPDATE OF hostname ON myfin.tenant_hosts
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_host_surface();
CREATE TRIGGER storefront_host_surface_guard BEFORE INSERT OR UPDATE OF hostname ON myfin.storefront_hosts
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_host_surface();
ALTER TABLE myfin.workspaces ADD CONSTRAINT workspaces_storefront_prefix_reserved
  CHECK(slug NOT LIKE 'order-%') NOT VALID;
ALTER TABLE myfin.companies ADD CONSTRAINT companies_storefront_prefix_reserved
  CHECK(slug NOT LIKE 'order-%') NOT VALID;

CREATE TABLE myfin.shop_locations (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  fulfillment_mode text NOT NULL DEFAULT 'pickup' CHECK(fulfillment_mode IN ('pickup','table','both')),
  table_label text NOT NULL DEFAULT '' CHECK(length(table_label) <= 80),
  pickup_instructions text NOT NULL DEFAULT '' CHECK(length(pickup_instructions) <= 1000),
  token_digest text NOT NULL CHECK(length(token_digest)=64),
  token_hint text NOT NULL CHECK(length(token_hint) BETWEEN 4 AND 12),
  token_version integer NOT NULL DEFAULT 1 CHECK(token_version > 0),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(token_digest)
);

CREATE TABLE myfin.storefront_products (
  company_id text NOT NULL,
  product_id text NOT NULL,
  published boolean NOT NULL DEFAULT false,
  sold_out boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN -1000000 AND 1000000),
  display_name text NOT NULL DEFAULT '' CHECK(length(display_name) <= 120),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,product_id),
  FOREIGN KEY(company_id,product_id) REFERENCES myfin.products(company_id,id) ON DELETE CASCADE
);
CREATE INDEX storefront_products_public_idx ON myfin.storefront_products(company_id,sort_order,product_id)
  WHERE published AND NOT sold_out;

CREATE TABLE myfin.storefront_product_variants (
  company_id text NOT NULL,
  product_id text NOT NULL,
  variant_id text NOT NULL,
  published boolean NOT NULL DEFAULT true,
  sold_out boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN -1000000 AND 1000000),
  PRIMARY KEY(company_id,product_id,variant_id),
  FOREIGN KEY(company_id,product_id) REFERENCES myfin.storefront_products(company_id,product_id) ON DELETE CASCADE,
  FOREIGN KEY(company_id,product_id,variant_id) REFERENCES myfin.product_variants(company_id,product_id,id) ON DELETE CASCADE
);

-- Consumer principals are global but are never staff principals. Provider links
-- are issuer/subject pairs, so an email string never grants account ownership.
CREATE TABLE myfin.customer_accounts (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  display_name text NOT NULL DEFAULT '' CHECK(length(display_name) <= 120),
  primary_email text CHECK(primary_email IS NULL OR length(primary_email) <= 254),
  email_verified_at timestamptz,
  adult_confirmed_at timestamptz NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(email_verified_at IS NULL OR primary_email IS NOT NULL)
);
CREATE UNIQUE INDEX customer_accounts_email_key ON myfin.customer_accounts(lower(primary_email))
  WHERE primary_email IS NOT NULL;
CREATE TABLE myfin.customer_identities (
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 500),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 500),
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer,subject)
);
CREATE INDEX customer_identities_customer_idx ON myfin.customer_identities(customer_id);
CREATE TABLE myfin.customer_guest_sessions (
  token_digest text PRIMARY KEY CHECK(length(token_digest)=64),
  storefront_hostname text NOT NULL REFERENCES myfin.storefront_hosts(hostname) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK(expires_at > created_at)
);
CREATE INDEX customer_guest_sessions_expiry_idx ON myfin.customer_guest_sessions(expires_at);
CREATE TABLE myfin.customer_workspace_profiles (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  display_name text NOT NULL DEFAULT '' CHECK(length(display_name) <= 120),
  phone text NOT NULL DEFAULT '' CHECK(length(phone) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,customer_id)
);
CREATE TABLE myfin.customer_company_links (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  client_id text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,customer_id),
  UNIQUE(company_id,client_id),
  FOREIGN KEY(company_id,client_id) REFERENCES myfin.clients(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE myfin.customer_consent_events (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK(purpose IN ('marketing')),
  channel text NOT NULL CHECK(channel IN ('email','sms','whatsapp')),
  granted boolean NOT NULL,
  notice_version text NOT NULL CHECK(length(notice_version) BETWEEN 1 AND 80),
  source text NOT NULL CHECK(length(source) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id)
);
CREATE INDEX customer_consent_current_idx ON myfin.customer_consent_events(workspace_id,customer_id,purpose,channel,created_at DESC);

CREATE TABLE myfin.workspace_loyalty_settings (
  workspace_id text PRIMARY KEY REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  stamps_per_order integer NOT NULL DEFAULT 1 CHECK(stamps_per_order=1),
  stamps_required integer NOT NULL DEFAULT 10 CHECK(stamps_required BETWEEN 2 AND 1000),
  reward_label text NOT NULL DEFAULT 'Reward' CHECK(length(btrim(reward_label)) BETWEEN 1 AND 120),
  minimum_spend numeric(18,2) NOT NULL DEFAULT 0 CHECK(minimum_spend BETWEEN 0 AND 1000000),
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE myfin.customer_loyalty_accounts (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  stamp_balance integer NOT NULL DEFAULT 0 CHECK(stamp_balance >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,customer_id)
);
CREATE TABLE myfin.customer_loyalty_events (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('earn','redeem','adjust','reverse')),
  stamps integer NOT NULL CHECK(stamps <> 0 AND stamps BETWEEN -1000000 AND 1000000),
  balance_after integer NOT NULL CHECK(balance_after >= 0),
  source_sale_id text,
  reason text NOT NULL DEFAULT '' CHECK(length(reason) <= 500),
  actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(company_id,source_sale_id) REFERENCES myfin.transactions(company_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX customer_loyalty_sale_earn_key ON myfin.customer_loyalty_events(workspace_id,company_id,source_sale_id)
  WHERE kind='earn' AND source_sale_id IS NOT NULL;
CREATE INDEX customer_loyalty_history_idx ON myfin.customer_loyalty_events(workspace_id,customer_id,created_at DESC);

CREATE TABLE myfin.customer_order_requests (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  public_code text NOT NULL CHECK(public_code ~ '^[A-Z0-9]{8}$'),
  location_id text NOT NULL,
  customer_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  guest_name text NOT NULL DEFAULT '' CHECK(length(guest_name) <= 120),
  guest_email text NOT NULL DEFAULT '' CHECK(length(guest_email) <= 254),
  guest_phone text NOT NULL DEFAULT '' CHECK(length(guest_phone) <= 80),
  notes text NOT NULL DEFAULT '' CHECK(length(notes) <= 1000),
  status text NOT NULL DEFAULT 'awaiting_acceptance' CHECK(status IN ('awaiting_acceptance','accepted','preparing','ready','cancelled','expired','paid')),
  payment_state text NOT NULL DEFAULT 'unpaid' CHECK(payment_state IN ('unpaid','paid')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  currency text NOT NULL CHECK(length(currency) BETWEEN 1 AND 8),
  subtotal numeric(18,2) NOT NULL CHECK(subtotal >= 0),
  discount_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK(discount_amount >= 0),
  tax numeric(18,2) NOT NULL DEFAULT 0 CHECK(tax >= 0),
  tax_rate numeric(7,4) NOT NULL DEFAULT 0 CHECK(tax_rate BETWEEN 0 AND 100),
  total_before_rounding numeric(18,2) NOT NULL CHECK(total_before_rounding >= 0),
  rounding numeric(18,2) NOT NULL DEFAULT 0 CHECK(rounding BETWEEN -0.02 AND 0.02),
  total numeric(18,2) NOT NULL CHECK(total > 0),
  guest_session_digest text NOT NULL REFERENCES myfin.customer_guest_sessions(token_digest) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  accepted_at timestamptz,
  pickup_at timestamptz,
  expires_at timestamptz NOT NULL,
  pii_redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,public_code),
  UNIQUE(company_id,idempotency_key),
  FOREIGN KEY(company_id,location_id) REFERENCES myfin.shop_locations(company_id,id) ON DELETE RESTRICT,
  CHECK(expires_at > created_at),
  CHECK((status='paid')=(payment_state='paid')),
  CHECK(payment_state='unpaid' OR status='paid')
);
CREATE INDEX customer_order_queue_idx ON myfin.customer_order_requests(company_id,status,created_at DESC);
CREATE INDEX customer_order_expiry_idx ON myfin.customer_order_requests(expires_at)
  WHERE status IN ('awaiting_acceptance','accepted','preparing','ready');
CREATE INDEX customer_order_contact_retention_idx
  ON myfin.customer_order_requests(company_id,updated_at,id)
  WHERE pii_redacted_at IS NULL AND status IN ('cancelled','expired','paid');

CREATE TABLE myfin.customer_order_lines (
  company_id text NOT NULL,
  order_id text NOT NULL,
  line_no integer NOT NULL CHECK(line_no BETWEEN 1 AND 100),
  product_id text NOT NULL,
  variant_id text,
  description text NOT NULL CHECK(length(description) BETWEEN 1 AND 500),
  variant_name text NOT NULL DEFAULT '' CHECK(length(variant_name) <= 120),
  sku text NOT NULL DEFAULT '' CHECK(length(sku) <= 120),
  unit text NOT NULL DEFAULT 'pcs' CHECK(length(unit) <= 120),
  quantity numeric(12,3) NOT NULL CHECK(quantity > 0 AND quantity <= 1000),
  unit_price numeric(18,4) NOT NULL CHECK(unit_price >= 0),
  line_total numeric(18,2) NOT NULL CHECK(line_total >= 0),
  PRIMARY KEY(company_id,order_id,line_no),
  FOREIGN KEY(company_id,order_id) REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id) REFERENCES myfin.products(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id,variant_id) REFERENCES myfin.product_variants(company_id,product_id,id) ON DELETE RESTRICT
);

CREATE TABLE myfin.customer_order_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  order_id text NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  actor_type text NOT NULL CHECK(actor_type IN ('guest','customer','staff','system')),
  staff_actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  customer_actor_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  action text NOT NULL CHECK(action IN ('submitted','status_changed','paid','expired')),
  from_status text,
  to_status text NOT NULL CHECK(to_status IN ('awaiting_acceptance','accepted','preparing','ready','cancelled','expired','paid')),
  note text NOT NULL DEFAULT '' CHECK(length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,order_id,version),
  UNIQUE(company_id,request_id),
  FOREIGN KEY(company_id,order_id) REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  CHECK((actor_type='staff' AND staff_actor_id IS NOT NULL AND customer_actor_id IS NULL) OR
        (actor_type='customer' AND staff_actor_id IS NULL AND customer_actor_id IS NOT NULL) OR
        (actor_type IN ('guest','system') AND staff_actor_id IS NULL AND customer_actor_id IS NULL))
);
CREATE INDEX customer_order_events_order_idx ON myfin.customer_order_events(company_id,order_id,version);

CREATE TABLE myfin.customer_order_reservations (
  company_id text NOT NULL,
  order_id text NOT NULL,
  line_no integer NOT NULL,
  product_id text NOT NULL,
  variant_id text,
  quantity numeric(12,3) NOT NULL CHECK(quantity > 0),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text CHECK(release_reason IS NULL OR length(release_reason) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,order_id,line_no),
  FOREIGN KEY(company_id,order_id,line_no) REFERENCES myfin.customer_order_lines(company_id,order_id,line_no) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id) REFERENCES myfin.products(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id,variant_id) REFERENCES myfin.product_variants(company_id,product_id,id) ON DELETE RESTRICT
);
CREATE INDEX customer_order_active_reservations_idx ON myfin.customer_order_reservations(company_id,product_id,variant_id)
  WHERE released_at IS NULL;

CREATE TABLE myfin.customer_order_payments (
  company_id text NOT NULL,
  order_id text NOT NULL,
  sale_id text NOT NULL,
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,order_id),
  UNIQUE(company_id,sale_id),
  UNIQUE(company_id,request_id),
  FOREIGN KEY(company_id,order_id) REFERENCES myfin.customer_order_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,sale_id) REFERENCES myfin.transactions(company_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION myfin.protect_customer_order_history() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'customer_order_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_customer_order_events BEFORE UPDATE OR DELETE ON myfin.customer_order_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_customer_order_history();
CREATE TRIGGER immutable_customer_order_payments BEFORE UPDATE OR DELETE ON myfin.customer_order_payments
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_customer_order_history();
CREATE TRIGGER immutable_customer_consent_events BEFORE UPDATE OR DELETE ON myfin.customer_consent_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_customer_order_history();
CREATE TRIGGER immutable_customer_loyalty_events BEFORE UPDATE OR DELETE ON myfin.customer_loyalty_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_customer_order_history();

-- Local customer credentials and sessions are purposefully separate from the
-- staff auth tables. customer_identities above remains the issuer/subject map
-- for a future OIDC provider and never infers ownership from an email address.
CREATE TABLE myfin.customer_credentials (
  customer_id text PRIMARY KEY REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  password_hash text NOT NULL CHECK(length(password_hash) BETWEEN 80 AND 500),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 1000000),
  locked_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE myfin.customer_sessions (
  token_digest text PRIMARY KEY CHECK(length(token_digest)=64),
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK(expires_at > created_at)
);
CREATE INDEX customer_sessions_customer_idx ON myfin.customer_sessions(customer_id,created_at DESC);
CREATE INDEX customer_sessions_expiry_idx ON myfin.customer_sessions(expires_at) WHERE revoked_at IS NULL;
