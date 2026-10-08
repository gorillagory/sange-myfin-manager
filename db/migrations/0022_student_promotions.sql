-- Student eligibility, versioned promotions and immutable integer-sen pricing.
-- This is an additive foundation: existing prices, orders, sales and loyalty
-- balances are unchanged until application routes explicitly opt in.

CREATE TABLE myfin.student_eligibilities (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK(status IN ('pending','verified','rejected','revoked')),
  institution_name text NOT NULL CHECK(length(btrim(institution_name)) BETWEEN 2 AND 160),
  verification_method text CHECK(verification_method IS NULL OR verification_method IN (
    'staff_attestation','institution_email','external_provider'
  )),
  verification_reference_digest text CHECK(
    verification_reference_digest IS NULL OR verification_reference_digest ~ '^[0-9a-f]{64}$'
  ),
  reference_hint text NOT NULL DEFAULT '' CHECK(
    reference_hint='' OR (length(reference_hint) BETWEEN 4 AND 11
      AND reference_hint ~ '^\*{3}[A-Za-z0-9._-]{1,8}$')
  ),
  valid_from timestamptz,
  valid_until timestamptz,
  version bigint NOT NULL CHECK(version > 0),
  updated_by_staff text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_by_customer text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,customer_id),
  CHECK((updated_by_staff IS NOT NULL)::integer + (updated_by_customer IS NOT NULL)::integer = 1),
  CHECK(
    (status='verified' AND verification_method IS NOT NULL AND verification_reference_digest IS NOT NULL
      AND valid_from IS NOT NULL AND valid_until IS NOT NULL AND valid_until > valid_from) OR
    (status<>'verified' AND verification_method IS NULL AND verification_reference_digest IS NULL
      AND valid_from IS NULL AND valid_until IS NULL)
  )
);
CREATE INDEX student_eligibilities_customer_idx
  ON myfin.student_eligibilities(customer_id,workspace_id);
CREATE INDEX student_eligibilities_review_idx
  ON myfin.student_eligibilities(workspace_id,status,updated_at,customer_id);
CREATE INDEX student_eligibilities_expiry_idx
  ON myfin.student_eligibilities(workspace_id,valid_until,customer_id)
  WHERE status='verified';

CREATE TABLE myfin.student_eligibility_events (
  workspace_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  customer_id text NOT NULL,
  version bigint NOT NULL CHECK(version > 0),
  action text NOT NULL CHECK(action IN ('request','verify','renew','reject','revoke')),
  from_status text CHECK(from_status IS NULL OR from_status IN ('pending','verified','rejected','revoked')),
  to_status text NOT NULL CHECK(to_status IN ('pending','verified','rejected','revoked')),
  actor_type text NOT NULL CHECK(actor_type IN ('customer','staff')),
  staff_actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  customer_actor_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  institution_name text NOT NULL CHECK(length(btrim(institution_name)) BETWEEN 2 AND 160),
  verification_method text CHECK(verification_method IS NULL OR verification_method IN (
    'staff_attestation','institution_email','external_provider'
  )),
  verification_reference_digest text CHECK(
    verification_reference_digest IS NULL OR verification_reference_digest ~ '^[0-9a-f]{64}$'
  ),
  reference_hint text NOT NULL DEFAULT '' CHECK(
    reference_hint='' OR (length(reference_hint) BETWEEN 4 AND 11
      AND reference_hint ~ '^\*{3}[A-Za-z0-9._-]{1,8}$')
  ),
  valid_from timestamptz,
  valid_until timestamptz,
  reason text NOT NULL DEFAULT '' CHECK(length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,customer_id,version),
  FOREIGN KEY(workspace_id,customer_id)
    REFERENCES myfin.student_eligibilities(workspace_id,customer_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(
    (actor_type='staff' AND staff_actor_id IS NOT NULL AND customer_actor_id IS NULL) OR
    (actor_type='customer' AND staff_actor_id IS NULL AND customer_actor_id=customer_id)
  ),
  CHECK(
    (action='request' AND to_status='pending') OR
    (action IN ('verify','renew') AND to_status='verified') OR
    (action='reject' AND to_status='rejected') OR
    (action='revoke' AND to_status='revoked')
  ),
  CHECK(
    (to_status='verified' AND verification_method IS NOT NULL AND verification_reference_digest IS NOT NULL
      AND valid_from IS NOT NULL AND valid_until IS NOT NULL AND valid_until > valid_from) OR
    (to_status<>'verified' AND verification_method IS NULL AND verification_reference_digest IS NULL
      AND valid_from IS NULL AND valid_until IS NULL)
  ),
  CHECK(to_status NOT IN ('rejected','revoked') OR length(btrim(reason)) >= 3)
);
CREATE INDEX student_eligibility_events_history_idx
  ON myfin.student_eligibility_events(workspace_id,customer_id,version DESC);

ALTER TABLE myfin.student_eligibilities ADD CONSTRAINT student_eligibilities_current_event_fk
  FOREIGN KEY(workspace_id,customer_id,version)
  REFERENCES myfin.student_eligibility_events(workspace_id,customer_id,version)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION myfin.enforce_student_eligibility_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.version<>1 THEN
    RAISE EXCEPTION 'student_eligibility_version_required' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
    NEW.customer_id IS DISTINCT FROM OLD.customer_id OR
    NEW.version<>OLD.version+1
  ) THEN
    RAISE EXCEPTION 'student_eligibility_version_required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER student_eligibility_version_guard
  BEFORE INSERT OR UPDATE ON myfin.student_eligibilities
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_student_eligibility_version();

CREATE FUNCTION myfin.require_student_eligibility_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM myfin.student_eligibility_events e
    WHERE e.workspace_id=NEW.workspace_id AND e.customer_id=NEW.customer_id AND e.version=NEW.version
      AND e.to_status=NEW.status AND e.institution_name=NEW.institution_name
      AND e.verification_method IS NOT DISTINCT FROM NEW.verification_method
      AND e.verification_reference_digest IS NOT DISTINCT FROM NEW.verification_reference_digest
      AND e.reference_hint=NEW.reference_hint
      AND e.valid_from IS NOT DISTINCT FROM NEW.valid_from
      AND e.valid_until IS NOT DISTINCT FROM NEW.valid_until
      AND ((e.actor_type='staff' AND e.staff_actor_id=NEW.updated_by_staff) OR
           (e.actor_type='customer' AND e.customer_actor_id=NEW.updated_by_customer))
  ) THEN
    RAISE EXCEPTION 'student_eligibility_event_required' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER student_eligibility_event_guard
  AFTER INSERT OR UPDATE ON myfin.student_eligibilities
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION myfin.require_student_eligibility_event();

CREATE FUNCTION myfin.protect_student_eligibility_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'student_eligibility_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_student_eligibility_events
  BEFORE UPDATE OR DELETE ON myfin.student_eligibility_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_student_eligibility_history();
CREATE TRIGGER no_truncate_student_eligibility_events
  BEFORE TRUNCATE ON myfin.student_eligibility_events
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_student_eligibility_history();
CREATE TRIGGER no_delete_student_eligibilities
  BEFORE DELETE ON myfin.student_eligibilities
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_student_eligibility_history();

-- The editable row points at an immutable version. Every rule used for a price
-- therefore remains available after a promotion is changed or disabled.
CREATE TABLE myfin.promotions (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  version bigint NOT NULL CHECK(version > 0),
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,id),
  UNIQUE(company_id,id),
  FOREIGN KEY(workspace_id,company_id)
    REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT
);

CREATE TABLE myfin.promotion_versions (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  version bigint NOT NULL CHECK(version > 0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  enabled boolean NOT NULL DEFAULT false,
  redemption_mode text NOT NULL CHECK(redemption_mode IN ('automatic','voucher')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  currency_code text NOT NULL DEFAULT 'MYR' CHECK(currency_code ~ '^[A-Z]{3}$'),
  discount_type text NOT NULL CHECK(discount_type IN ('percentage','fixed')),
  discount_basis_points integer,
  discount_sen bigint,
  max_discount_sen bigint,
  min_subtotal_sen bigint NOT NULL DEFAULT 0 CHECK(min_subtotal_sen BETWEEN 0 AND 9000000000000000),
  max_total_redemptions bigint CHECK(max_total_redemptions IS NULL OR max_total_redemptions > 0),
  per_customer_limit integer CHECK(per_customer_limit IS NULL OR per_customer_limit > 0),
  requires_customer boolean NOT NULL DEFAULT false,
  requires_student boolean NOT NULL DEFAULT false,
  stackable boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0 CHECK(priority BETWEEN -1000000 AND 1000000),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,promotion_id,version),
  FOREIGN KEY(workspace_id,company_id,promotion_id)
    REFERENCES myfin.promotions(workspace_id,company_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(valid_until IS NULL OR valid_until > valid_from),
  CHECK((discount_type='percentage' AND discount_basis_points IS NOT NULL
       AND discount_basis_points BETWEEN 1 AND 10000 AND discount_sen IS NULL)
     OR (discount_type='fixed' AND discount_basis_points IS NULL AND discount_sen IS NOT NULL
       AND discount_sen BETWEEN 1 AND 9000000000000000)),
  CHECK(max_discount_sen IS NULL OR max_discount_sen BETWEEN 1 AND 9000000000000000),
  CHECK(NOT requires_student OR requires_customer)
);
CREATE INDEX promotion_versions_validity_idx
  ON myfin.promotion_versions(workspace_id,company_id,enabled,valid_from,valid_until);
ALTER TABLE myfin.promotions ADD CONSTRAINT promotions_current_version_fk
  FOREIGN KEY(workspace_id,company_id,id,version)
  REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION myfin.enforce_current_version_step() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.version<>1 THEN
    RAISE EXCEPTION 'current_version_must_start_at_one' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' AND NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'current_version_must_advance_once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION myfin.enforce_promotion_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'promotion_identity_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER promotion_current_version_guard
  BEFORE INSERT OR UPDATE ON myfin.promotions
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_current_version_step();
CREATE TRIGGER promotion_identity_guard
  BEFORE UPDATE ON myfin.promotions
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_promotion_identity();

CREATE TABLE myfin.promotion_version_products (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  promotion_version bigint NOT NULL,
  product_id text NOT NULL,
  variant_id text,
  variant_key text GENERATED ALWAYS AS (coalesce(variant_id,'')) STORED,
  PRIMARY KEY(workspace_id,company_id,promotion_id,promotion_version,product_id,variant_key),
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id)
    REFERENCES myfin.products(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id,variant_id)
    REFERENCES myfin.product_variants(company_id,product_id,id) ON DELETE RESTRICT
);

CREATE TABLE myfin.promotion_version_categories (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  promotion_version bigint NOT NULL,
  category_key text NOT NULL CHECK(
    category_key=lower(btrim(category_key)) AND length(category_key) BETWEEN 1 AND 120
  ),
  subcategory_key text NOT NULL DEFAULT '' CHECK(
    subcategory_key=lower(btrim(subcategory_key)) AND length(subcategory_key) <= 120
  ),
  PRIMARY KEY(workspace_id,company_id,promotion_id,promotion_version,category_key,subcategory_key),
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT
);

CREATE TABLE myfin.promotion_version_customers (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  promotion_version bigint NOT NULL,
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  PRIMARY KEY(workspace_id,company_id,promotion_id,promotion_version,customer_id),
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT
);
CREATE INDEX promotion_version_customers_customer_idx
  ON myfin.promotion_version_customers(workspace_id,customer_id,company_id,promotion_id);

-- Voucher codes are bearer credentials. The database stores only a lookup HMAC
-- produced with an external pepper and a non-sensitive display hint.
CREATE TABLE myfin.promotion_vouchers (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  promotion_id text NOT NULL,
  code_lookup_digest text NOT NULL CHECK(code_lookup_digest ~ '^[0-9a-f]{64}$'),
  code_hint text NOT NULL CHECK(length(code_hint) BETWEEN 2 AND 8 AND code_hint ~ '^[A-Z0-9*-]+$'),
  version bigint NOT NULL CHECK(version > 0),
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,promotion_id,id),
  UNIQUE(company_id,id),
  UNIQUE(company_id,code_lookup_digest),
  FOREIGN KEY(workspace_id,company_id,promotion_id)
    REFERENCES myfin.promotions(workspace_id,company_id,id) ON DELETE RESTRICT
);

CREATE TABLE myfin.promotion_voucher_versions (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  voucher_id text NOT NULL,
  version bigint NOT NULL CHECK(version > 0),
  enabled boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  max_redemptions bigint CHECK(max_redemptions IS NULL OR max_redemptions > 0),
  per_customer_limit integer CHECK(per_customer_limit IS NULL OR per_customer_limit > 0),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,promotion_id,voucher_id,version),
  FOREIGN KEY(workspace_id,company_id,promotion_id,voucher_id)
    REFERENCES myfin.promotion_vouchers(workspace_id,company_id,promotion_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(valid_until IS NULL OR valid_until > valid_from)
);
ALTER TABLE myfin.promotion_vouchers ADD CONSTRAINT promotion_vouchers_current_version_fk
  FOREIGN KEY(workspace_id,company_id,promotion_id,id,version)
  REFERENCES myfin.promotion_voucher_versions(workspace_id,company_id,promotion_id,voucher_id,version)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION myfin.enforce_voucher_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.company_id IS DISTINCT FROM OLD.company_id OR
     NEW.promotion_id IS DISTINCT FROM OLD.promotion_id OR NEW.id IS DISTINCT FROM OLD.id OR
     NEW.code_lookup_digest IS DISTINCT FROM OLD.code_lookup_digest THEN
    RAISE EXCEPTION 'voucher_identity_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER promotion_voucher_current_version_guard
  BEFORE INSERT OR UPDATE ON myfin.promotion_vouchers
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_current_version_step();
CREATE TRIGGER promotion_voucher_identity_guard
  BEFORE UPDATE ON myfin.promotion_vouchers
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_voucher_identity();

CREATE FUNCTION myfin.protect_promotion_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'promotion_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_promotion_versions
  BEFORE UPDATE OR DELETE ON myfin.promotion_versions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER immutable_promotion_version_products
  BEFORE UPDATE OR DELETE ON myfin.promotion_version_products
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER immutable_promotion_version_categories
  BEFORE UPDATE OR DELETE ON myfin.promotion_version_categories
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER immutable_promotion_version_customers
  BEFORE UPDATE OR DELETE ON myfin.promotion_version_customers
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER immutable_promotion_voucher_versions
  BEFORE UPDATE OR DELETE ON myfin.promotion_voucher_versions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_promotion_versions
  BEFORE TRUNCATE ON myfin.promotion_versions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_promotion_version_products
  BEFORE TRUNCATE ON myfin.promotion_version_products
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_promotion_version_categories
  BEFORE TRUNCATE ON myfin.promotion_version_categories
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_promotion_version_customers
  BEFORE TRUNCATE ON myfin.promotion_version_customers
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_promotion_voucher_versions
  BEFORE TRUNCATE ON myfin.promotion_voucher_versions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();

CREATE TABLE myfin.pricing_snapshots (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  customer_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  student_eligibility_version bigint,
  currency_code text NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
  subtotal_sen bigint NOT NULL CHECK(subtotal_sen BETWEEN 0 AND 9000000000000000),
  discount_sen bigint NOT NULL DEFAULT 0 CHECK(discount_sen BETWEEN 0 AND 9000000000000000),
  taxable_sen bigint NOT NULL CHECK(taxable_sen BETWEEN 0 AND 9000000000000000),
  tax_sen bigint NOT NULL DEFAULT 0 CHECK(tax_sen BETWEEN 0 AND 9000000000000000),
  rounding_sen smallint NOT NULL DEFAULT 0 CHECK(rounding_sen BETWEEN -2 AND 2),
  total_sen bigint NOT NULL CHECK(total_sen BETWEEN 0 AND 9000000000000000),
  rules_digest text NOT NULL CHECK(rules_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  priced_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,id),
  UNIQUE(company_id,id),
  FOREIGN KEY(workspace_id,company_id)
    REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,customer_id,student_eligibility_version)
    REFERENCES myfin.student_eligibility_events(workspace_id,customer_id,version) ON DELETE RESTRICT,
  CHECK(student_eligibility_version IS NULL OR customer_id IS NOT NULL),
  CHECK(taxable_sen=subtotal_sen-discount_sen),
  CHECK(total_sen=taxable_sen+tax_sen+rounding_sen),
  CHECK(expires_at IS NULL OR expires_at > priced_at)
);
CREATE INDEX pricing_snapshots_customer_idx
  ON myfin.pricing_snapshots(workspace_id,customer_id,priced_at DESC,id)
  WHERE customer_id IS NOT NULL;

CREATE TABLE myfin.pricing_snapshot_lines (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  snapshot_id text NOT NULL,
  line_no integer NOT NULL CHECK(line_no BETWEEN 1 AND 500),
  product_id text NOT NULL,
  variant_id text,
  category text NOT NULL DEFAULT '' CHECK(length(category) <= 120),
  subcategory text NOT NULL DEFAULT '' CHECK(length(subcategory) <= 120),
  description text NOT NULL CHECK(length(description) BETWEEN 1 AND 500),
  quantity_milli bigint NOT NULL CHECK(quantity_milli BETWEEN 1 AND 1000000000),
  unit_price_sen bigint NOT NULL CHECK(unit_price_sen BETWEEN 0 AND 9000000000000000),
  gross_sen bigint NOT NULL CHECK(gross_sen BETWEEN 0 AND 9000000000000000),
  discount_sen bigint NOT NULL DEFAULT 0 CHECK(discount_sen BETWEEN 0 AND 9000000000000000),
  net_sen bigint NOT NULL CHECK(net_sen BETWEEN 0 AND 9000000000000000),
  PRIMARY KEY(workspace_id,company_id,snapshot_id,line_no),
  FOREIGN KEY(workspace_id,company_id,snapshot_id)
    REFERENCES myfin.pricing_snapshots(workspace_id,company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id)
    REFERENCES myfin.products(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,product_id,variant_id)
    REFERENCES myfin.product_variants(company_id,product_id,id) ON DELETE RESTRICT,
  CHECK(net_sen=gross_sen-discount_sen)
);

CREATE TABLE myfin.pricing_snapshot_discounts (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  snapshot_id text NOT NULL,
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100),
  promotion_id text NOT NULL,
  promotion_version bigint NOT NULL,
  voucher_id text,
  voucher_version bigint,
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
  discount_sen bigint NOT NULL CHECK(discount_sen BETWEEN 1 AND 9000000000000000),
  PRIMARY KEY(workspace_id,company_id,snapshot_id,sequence),
  UNIQUE(workspace_id,company_id,snapshot_id,promotion_id),
  FOREIGN KEY(workspace_id,company_id,snapshot_id)
    REFERENCES myfin.pricing_snapshots(workspace_id,company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,promotion_id,voucher_id,voucher_version)
    REFERENCES myfin.promotion_voucher_versions(workspace_id,company_id,promotion_id,voucher_id,version)
    ON DELETE RESTRICT,
  CHECK((voucher_id IS NULL)=(voucher_version IS NULL))
);

CREATE TABLE myfin.pricing_snapshot_discount_lines (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  snapshot_id text NOT NULL,
  discount_sequence integer NOT NULL CHECK(discount_sequence BETWEEN 1 AND 100),
  line_no integer NOT NULL CHECK(line_no BETWEEN 1 AND 500),
  discount_sen bigint NOT NULL CHECK(discount_sen BETWEEN 1 AND 9000000000000000),
  PRIMARY KEY(workspace_id,company_id,snapshot_id,discount_sequence,line_no),
  FOREIGN KEY(workspace_id,company_id,snapshot_id,discount_sequence)
    REFERENCES myfin.pricing_snapshot_discounts(workspace_id,company_id,snapshot_id,sequence)
    ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,snapshot_id,line_no)
    REFERENCES myfin.pricing_snapshot_lines(workspace_id,company_id,snapshot_id,line_no)
    ON DELETE RESTRICT
);

CREATE FUNCTION myfin.require_pricing_snapshot_details() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
DECLARE
  line_gross bigint;
  line_discount bigint;
  line_net bigint;
  application_discount bigint;
BEGIN
  SELECT coalesce(sum(gross_sen),0),coalesce(sum(discount_sen),0),coalesce(sum(net_sen),0)
    INTO line_gross,line_discount,line_net
    FROM myfin.pricing_snapshot_lines
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id AND snapshot_id=NEW.id;
  SELECT coalesce(sum(discount_sen),0) INTO application_discount
    FROM myfin.pricing_snapshot_discounts
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id AND snapshot_id=NEW.id;
  IF line_gross<>NEW.subtotal_sen OR line_discount<>NEW.discount_sen OR
     line_net<>NEW.taxable_sen OR application_discount<>NEW.discount_sen THEN
    RAISE EXCEPTION 'pricing_snapshot_details_required' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM myfin.pricing_snapshot_discounts d
    WHERE d.workspace_id=NEW.workspace_id AND d.company_id=NEW.company_id AND d.snapshot_id=NEW.id
      AND d.discount_sen<>(SELECT coalesce(sum(dl.discount_sen),0)
        FROM myfin.pricing_snapshot_discount_lines dl
        WHERE dl.workspace_id=d.workspace_id AND dl.company_id=d.company_id
          AND dl.snapshot_id=d.snapshot_id AND dl.discount_sequence=d.sequence)
  ) THEN
    RAISE EXCEPTION 'pricing_snapshot_discount_lines_required' USING ERRCODE='23514';
  END IF;
  IF NEW.student_eligibility_version IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM myfin.student_eligibility_events e
    WHERE e.workspace_id=NEW.workspace_id AND e.customer_id=NEW.customer_id
      AND e.version=NEW.student_eligibility_version AND e.to_status='verified'
      AND NEW.priced_at>=e.valid_from AND NEW.priced_at<e.valid_until
  ) THEN
    RAISE EXCEPTION 'pricing_snapshot_student_eligibility_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pricing_snapshot_details_guard
  AFTER INSERT ON myfin.pricing_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION myfin.require_pricing_snapshot_details();

CREATE TABLE myfin.promotion_redemptions (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  promotion_id text NOT NULL,
  promotion_version bigint NOT NULL,
  voucher_id text,
  voucher_version bigint,
  pricing_snapshot_id text NOT NULL,
  customer_id text REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK(source_type IN ('customer_order','pos_sale','invoice')),
  source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  discount_sen bigint NOT NULL CHECK(discount_sen BETWEEN 1 AND 9000000000000000),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,id),
  UNIQUE(company_id,idempotency_key),
  UNIQUE(company_id,promotion_id,source_type,source_id),
  FOREIGN KEY(workspace_id,company_id,promotion_id,promotion_version)
    REFERENCES myfin.promotion_versions(workspace_id,company_id,promotion_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,promotion_id,voucher_id,voucher_version)
    REFERENCES myfin.promotion_voucher_versions(workspace_id,company_id,promotion_id,voucher_id,version)
    ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id,pricing_snapshot_id)
    REFERENCES myfin.pricing_snapshots(workspace_id,company_id,id) ON DELETE RESTRICT,
  CHECK((voucher_id IS NULL)=(voucher_version IS NULL))
);
CREATE INDEX promotion_redemptions_promotion_usage_idx
  ON myfin.promotion_redemptions(workspace_id,company_id,promotion_id,created_at,id);
CREATE INDEX promotion_redemptions_customer_usage_idx
  ON myfin.promotion_redemptions(workspace_id,company_id,promotion_id,customer_id,created_at,id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX promotion_redemptions_voucher_usage_idx
  ON myfin.promotion_redemptions(workspace_id,company_id,voucher_id,customer_id,created_at,id)
  WHERE voucher_id IS NOT NULL;

CREATE TABLE myfin.promotion_usage_counters (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  redemption_count bigint NOT NULL DEFAULT 0 CHECK(redemption_count >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,promotion_id),
  FOREIGN KEY(workspace_id,company_id,promotion_id)
    REFERENCES myfin.promotions(workspace_id,company_id,id) ON DELETE RESTRICT
);
CREATE TABLE myfin.promotion_customer_usage_counters (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  redemption_count bigint NOT NULL DEFAULT 0 CHECK(redemption_count >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,promotion_id,customer_id),
  FOREIGN KEY(workspace_id,company_id,promotion_id)
    REFERENCES myfin.promotions(workspace_id,company_id,id) ON DELETE RESTRICT
);
CREATE TABLE myfin.promotion_voucher_usage_counters (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  voucher_id text NOT NULL,
  redemption_count bigint NOT NULL DEFAULT 0 CHECK(redemption_count >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,promotion_id,voucher_id),
  FOREIGN KEY(workspace_id,company_id,promotion_id,voucher_id)
    REFERENCES myfin.promotion_vouchers(workspace_id,company_id,promotion_id,id) ON DELETE RESTRICT
);
CREATE TABLE myfin.promotion_voucher_customer_usage_counters (
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  promotion_id text NOT NULL,
  voucher_id text NOT NULL,
  customer_id text NOT NULL REFERENCES myfin.customer_accounts(id) ON DELETE RESTRICT,
  redemption_count bigint NOT NULL DEFAULT 0 CHECK(redemption_count >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,promotion_id,voucher_id,customer_id),
  FOREIGN KEY(workspace_id,company_id,promotion_id,voucher_id)
    REFERENCES myfin.promotion_vouchers(workspace_id,company_id,promotion_id,id) ON DELETE RESTRICT
);

-- All writers pass through this trigger. Atomic counter upserts serialize
-- competing redemptions and prevent global and per-customer limit overspend.
CREATE FUNCTION myfin.enforce_promotion_redemption() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE
  current_promotion myfin.promotions%ROWTYPE;
  rule myfin.promotion_versions%ROWTYPE;
  current_voucher myfin.promotion_vouchers%ROWTYPE;
  voucher_rule myfin.promotion_voucher_versions%ROWTYPE;
  snapshot myfin.pricing_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO current_promotion FROM myfin.promotions
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id AND id=NEW.promotion_id
    FOR UPDATE;
  IF NOT FOUND OR current_promotion.version<>NEW.promotion_version THEN
    RAISE EXCEPTION 'promotion_changed' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT rule FROM myfin.promotion_versions
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
      AND promotion_id=NEW.promotion_id AND version=NEW.promotion_version;
  IF NOT rule.enabled OR NEW.occurred_at<rule.valid_from OR
     (rule.valid_until IS NOT NULL AND NEW.occurred_at>=rule.valid_until) THEN
    RAISE EXCEPTION 'promotion_unavailable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT snapshot FROM myfin.pricing_snapshots
    WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id AND id=NEW.pricing_snapshot_id;
  IF snapshot.customer_id IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'promotion_customer_changed' USING ERRCODE='23514';
  END IF;
  IF rule.requires_customer AND NEW.customer_id IS NULL THEN
    RAISE EXCEPTION 'promotion_customer_required' USING ERRCODE='23514';
  END IF;
  IF rule.requires_student AND snapshot.student_eligibility_version IS NULL THEN
    RAISE EXCEPTION 'student_eligibility_required' USING ERRCODE='23514';
  END IF;
  IF rule.requires_student AND NOT EXISTS(
    SELECT 1 FROM myfin.student_eligibility_events e
    WHERE e.workspace_id=NEW.workspace_id AND e.customer_id=NEW.customer_id
      AND e.version=snapshot.student_eligibility_version AND e.to_status='verified'
      AND snapshot.priced_at>=e.valid_from AND snapshot.priced_at<e.valid_until
  ) THEN
    RAISE EXCEPTION 'student_eligibility_expired' USING ERRCODE='23514';
  END IF;
  IF snapshot.expires_at IS NOT NULL AND NEW.occurred_at>=snapshot.expires_at THEN
    RAISE EXCEPTION 'pricing_snapshot_expired' USING ERRCODE='23514';
  END IF;
  IF snapshot.currency_code<>rule.currency_code OR snapshot.subtotal_sen<rule.min_subtotal_sen THEN
    RAISE EXCEPTION 'pricing_snapshot_rule_changed' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM myfin.promotion_version_customers pc
    WHERE pc.workspace_id=NEW.workspace_id AND pc.company_id=NEW.company_id
      AND pc.promotion_id=NEW.promotion_id AND pc.promotion_version=NEW.promotion_version
  ) AND NOT EXISTS(
    SELECT 1 FROM myfin.promotion_version_customers pc
    WHERE pc.workspace_id=NEW.workspace_id AND pc.company_id=NEW.company_id
      AND pc.promotion_id=NEW.promotion_id AND pc.promotion_version=NEW.promotion_version
      AND pc.customer_id=NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'promotion_customer_ineligible' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM myfin.pricing_snapshot_discounts d
    WHERE d.workspace_id=NEW.workspace_id AND d.company_id=NEW.company_id
      AND d.snapshot_id=NEW.pricing_snapshot_id AND d.promotion_id=NEW.promotion_id
      AND d.promotion_version=NEW.promotion_version
      AND d.voucher_id IS NOT DISTINCT FROM NEW.voucher_id
      AND d.voucher_version IS NOT DISTINCT FROM NEW.voucher_version
      AND d.discount_sen=NEW.discount_sen
  ) THEN
    RAISE EXCEPTION 'pricing_snapshot_discount_changed' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM myfin.pricing_snapshot_discount_lines dl
    JOIN myfin.pricing_snapshot_discounts d
      ON d.workspace_id=dl.workspace_id AND d.company_id=dl.company_id
      AND d.snapshot_id=dl.snapshot_id AND d.sequence=dl.discount_sequence
    JOIN myfin.pricing_snapshot_lines l
      ON l.workspace_id=dl.workspace_id AND l.company_id=dl.company_id
      AND l.snapshot_id=dl.snapshot_id AND l.line_no=dl.line_no
    WHERE d.workspace_id=NEW.workspace_id AND d.company_id=NEW.company_id
      AND d.snapshot_id=NEW.pricing_snapshot_id AND d.promotion_id=NEW.promotion_id
      AND (EXISTS(
        SELECT 1 FROM myfin.promotion_version_products pp
        WHERE pp.workspace_id=NEW.workspace_id AND pp.company_id=NEW.company_id
          AND pp.promotion_id=NEW.promotion_id AND pp.promotion_version=NEW.promotion_version
      ) OR EXISTS(
        SELECT 1 FROM myfin.promotion_version_categories pc
        WHERE pc.workspace_id=NEW.workspace_id AND pc.company_id=NEW.company_id
          AND pc.promotion_id=NEW.promotion_id AND pc.promotion_version=NEW.promotion_version
      ))
      AND NOT (
        EXISTS(SELECT 1 FROM myfin.promotion_version_products pp
          WHERE pp.workspace_id=NEW.workspace_id AND pp.company_id=NEW.company_id
            AND pp.promotion_id=NEW.promotion_id AND pp.promotion_version=NEW.promotion_version
            AND pp.product_id=l.product_id AND (pp.variant_id IS NULL OR pp.variant_id=l.variant_id))
        OR EXISTS(SELECT 1 FROM myfin.promotion_version_categories pc
          WHERE pc.workspace_id=NEW.workspace_id AND pc.company_id=NEW.company_id
            AND pc.promotion_id=NEW.promotion_id AND pc.promotion_version=NEW.promotion_version
            AND pc.category_key=lower(btrim(l.category))
            AND (pc.subcategory_key='' OR pc.subcategory_key=lower(btrim(l.subcategory))))
      )
  ) THEN
    RAISE EXCEPTION 'promotion_product_ineligible' USING ERRCODE='23514';
  END IF;
  IF ((rule.redemption_mode='voucher' AND NEW.voucher_id IS NULL) OR
      (rule.redemption_mode='automatic' AND NEW.voucher_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'promotion_redemption_mode_changed' USING ERRCODE='23514';
  END IF;
  INSERT INTO myfin.promotion_usage_counters AS usage_total(workspace_id,company_id,promotion_id,redemption_count)
    VALUES(NEW.workspace_id,NEW.company_id,NEW.promotion_id,1)
    ON CONFLICT(workspace_id,company_id,promotion_id) DO UPDATE SET
      redemption_count=usage_total.redemption_count+1,
      version=usage_total.version+1,updated_at=now()
      WHERE rule.max_total_redemptions IS NULL OR
        usage_total.redemption_count<rule.max_total_redemptions;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promotion_usage_limit' USING ERRCODE='23514';
  END IF;
  IF rule.per_customer_limit IS NOT NULL AND NEW.customer_id IS NULL THEN
    RAISE EXCEPTION 'promotion_customer_required' USING ERRCODE='23514';
  END IF;
  IF NEW.customer_id IS NOT NULL THEN
    INSERT INTO myfin.promotion_customer_usage_counters AS customer_usage(
      workspace_id,company_id,promotion_id,customer_id,redemption_count)
      VALUES(NEW.workspace_id,NEW.company_id,NEW.promotion_id,NEW.customer_id,1)
      ON CONFLICT(workspace_id,company_id,promotion_id,customer_id) DO UPDATE SET
        redemption_count=customer_usage.redemption_count+1,
        version=customer_usage.version+1,updated_at=now()
        WHERE rule.per_customer_limit IS NULL OR
          customer_usage.redemption_count<rule.per_customer_limit;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'promotion_customer_usage_limit' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.voucher_id IS NOT NULL THEN
    SELECT * INTO current_voucher FROM myfin.promotion_vouchers
      WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
        AND promotion_id=NEW.promotion_id AND id=NEW.voucher_id FOR UPDATE;
    IF NOT FOUND OR current_voucher.version<>NEW.voucher_version THEN
      RAISE EXCEPTION 'voucher_changed' USING ERRCODE='23514';
    END IF;
    SELECT * INTO STRICT voucher_rule FROM myfin.promotion_voucher_versions
      WHERE workspace_id=NEW.workspace_id AND company_id=NEW.company_id
        AND promotion_id=NEW.promotion_id AND voucher_id=NEW.voucher_id AND version=NEW.voucher_version;
    IF NOT voucher_rule.enabled OR NEW.occurred_at<voucher_rule.valid_from OR
       (voucher_rule.valid_until IS NOT NULL AND NEW.occurred_at>=voucher_rule.valid_until) THEN
      RAISE EXCEPTION 'voucher_unavailable' USING ERRCODE='23514';
    END IF;
    INSERT INTO myfin.promotion_voucher_usage_counters AS voucher_usage(
      workspace_id,company_id,promotion_id,voucher_id,redemption_count)
      VALUES(NEW.workspace_id,NEW.company_id,NEW.promotion_id,NEW.voucher_id,1)
      ON CONFLICT(workspace_id,company_id,promotion_id,voucher_id) DO UPDATE SET
        redemption_count=voucher_usage.redemption_count+1,
        version=voucher_usage.version+1,updated_at=now()
        WHERE voucher_rule.max_redemptions IS NULL OR
          voucher_usage.redemption_count<voucher_rule.max_redemptions;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'voucher_usage_limit' USING ERRCODE='23514';
    END IF;
    IF voucher_rule.per_customer_limit IS NOT NULL AND NEW.customer_id IS NULL THEN
      RAISE EXCEPTION 'voucher_customer_required' USING ERRCODE='23514';
    END IF;
    IF NEW.customer_id IS NOT NULL THEN
      INSERT INTO myfin.promotion_voucher_customer_usage_counters AS voucher_customer_usage(
        workspace_id,company_id,promotion_id,voucher_id,customer_id,redemption_count)
        VALUES(NEW.workspace_id,NEW.company_id,NEW.promotion_id,NEW.voucher_id,NEW.customer_id,1)
        ON CONFLICT(workspace_id,company_id,promotion_id,voucher_id,customer_id) DO UPDATE SET
          redemption_count=voucher_customer_usage.redemption_count+1,
          version=voucher_customer_usage.version+1,updated_at=now()
          WHERE voucher_rule.per_customer_limit IS NULL OR
            voucher_customer_usage.redemption_count<voucher_rule.per_customer_limit;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'voucher_customer_usage_limit' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER promotion_redemption_limit_guard
  BEFORE INSERT ON myfin.promotion_redemptions
  FOR EACH ROW EXECUTE FUNCTION myfin.enforce_promotion_redemption();
CREATE TRIGGER immutable_promotion_redemptions
  BEFORE UPDATE OR DELETE ON myfin.promotion_redemptions
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_promotion_redemptions
  BEFORE TRUNCATE ON myfin.promotion_redemptions
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();

CREATE TRIGGER immutable_pricing_snapshots
  BEFORE UPDATE OR DELETE ON myfin.pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER immutable_pricing_snapshot_lines
  BEFORE UPDATE OR DELETE ON myfin.pricing_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER immutable_pricing_snapshot_discounts
  BEFORE UPDATE OR DELETE ON myfin.pricing_snapshot_discounts
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER immutable_pricing_snapshot_discount_lines
  BEFORE UPDATE OR DELETE ON myfin.pricing_snapshot_discount_lines
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_pricing_snapshots
  BEFORE TRUNCATE ON myfin.pricing_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_pricing_snapshot_lines
  BEFORE TRUNCATE ON myfin.pricing_snapshot_lines
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_pricing_snapshot_discounts
  BEFORE TRUNCATE ON myfin.pricing_snapshot_discounts
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();
CREATE TRIGGER no_truncate_pricing_snapshot_discount_lines
  BEFORE TRUNCATE ON myfin.pricing_snapshot_discount_lines
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_promotion_history();

ALTER TABLE myfin.customer_order_requests ADD COLUMN pricing_snapshot_id text;
ALTER TABLE myfin.customer_order_requests ADD CONSTRAINT customer_orders_pricing_snapshot_fk
  FOREIGN KEY(company_id,pricing_snapshot_id)
  REFERENCES myfin.pricing_snapshots(company_id,id) ON DELETE RESTRICT;
ALTER TABLE myfin.transactions ADD COLUMN pricing_snapshot_id text;
ALTER TABLE myfin.transactions ADD CONSTRAINT transactions_pricing_snapshot_fk
  FOREIGN KEY(company_id,pricing_snapshot_id)
  REFERENCES myfin.pricing_snapshots(company_id,id) ON DELETE RESTRICT;

REVOKE ALL ON myfin.student_eligibilities FROM PUBLIC;
REVOKE ALL ON myfin.student_eligibility_events FROM PUBLIC;
REVOKE ALL ON myfin.promotions FROM PUBLIC;
REVOKE ALL ON myfin.promotion_versions FROM PUBLIC;
REVOKE ALL ON myfin.promotion_version_products FROM PUBLIC;
REVOKE ALL ON myfin.promotion_version_categories FROM PUBLIC;
REVOKE ALL ON myfin.promotion_version_customers FROM PUBLIC;
REVOKE ALL ON myfin.promotion_vouchers FROM PUBLIC;
REVOKE ALL ON myfin.promotion_voucher_versions FROM PUBLIC;
REVOKE ALL ON myfin.pricing_snapshots FROM PUBLIC;
REVOKE ALL ON myfin.pricing_snapshot_lines FROM PUBLIC;
REVOKE ALL ON myfin.pricing_snapshot_discounts FROM PUBLIC;
REVOKE ALL ON myfin.pricing_snapshot_discount_lines FROM PUBLIC;
REVOKE ALL ON myfin.promotion_redemptions FROM PUBLIC;
REVOKE ALL ON myfin.promotion_usage_counters FROM PUBLIC;
REVOKE ALL ON myfin.promotion_customer_usage_counters FROM PUBLIC;
REVOKE ALL ON myfin.promotion_voucher_usage_counters FROM PUBLIC;
REVOKE ALL ON myfin.promotion_voucher_customer_usage_counters FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_student_eligibility_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_student_eligibility_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.require_student_eligibility_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_promotion_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_current_version_step() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_promotion_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_voucher_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.enforce_promotion_redemption() FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.require_pricing_snapshot_details() FROM PUBLIC;

COMMENT ON COLUMN myfin.student_eligibilities.verification_reference_digest IS
  'Digest of an external verification reference. Raw student IDs, document bytes, document URLs and provider secrets are forbidden.';
COMMENT ON COLUMN myfin.promotion_vouchers.code_lookup_digest IS
  'HMAC-SHA-256 lookup digest produced with a server-side pepper. Plain voucher codes are never stored.';
COMMENT ON TABLE myfin.pricing_snapshots IS
  'Immutable integer-sen result used to bind an order, POS sale or invoice to the exact promotion and student-eligibility versions priced at that time.';
COMMENT ON TABLE myfin.promotion_redemptions IS
  'Immutable committed usage. Quotes do not consume limits; create this row atomically with the accepted order or sale.';
