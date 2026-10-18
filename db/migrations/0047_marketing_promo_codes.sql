-- Reusable promotion codes are public marketing identifiers, not authentication
-- credentials. Keep the normalized display value for staff reuse and QR/deep
-- links while retaining the HMAC lookup used by checkout. Existing codes remain
-- valid but cannot be recovered, so they stay NULL and are shown by their hint.

ALTER TABLE myfin.promotion_vouchers
  ADD COLUMN display_code text,
  ADD CONSTRAINT promotion_vouchers_display_code_check CHECK(
    display_code IS NULL OR (
      display_code=upper(btrim(display_code)) AND
      display_code ~ '^[A-Z0-9](?:[A-Z0-9-]{1,30}[A-Z0-9])$'
    )
  );

CREATE UNIQUE INDEX promotion_vouchers_company_display_code_key
  ON myfin.promotion_vouchers(company_id,display_code)
  WHERE display_code IS NOT NULL;

-- A code may be explicitly attributed to one campaign identity. The campaign's
-- exact promotion-version link and channel/schedule still decide eligibility at
-- quote time, so pausing or completing a campaign disables the code immediately.
ALTER TABLE myfin.promotion_voucher_versions
  ADD COLUMN campaign_id text,
  ADD CONSTRAINT promotion_voucher_versions_campaign_fkey
    FOREIGN KEY(workspace_id,company_id,campaign_id)
    REFERENCES myfin.marketing_campaigns(workspace_id,company_id,id) ON DELETE RESTRICT;

CREATE INDEX promotion_voucher_versions_campaign_idx
  ON myfin.promotion_voucher_versions(workspace_id,company_id,campaign_id,created_at)
  WHERE campaign_id IS NOT NULL;

CREATE OR REPLACE FUNCTION myfin.enforce_voucher_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.company_id IS DISTINCT FROM OLD.company_id OR
     NEW.promotion_id IS DISTINCT FROM OLD.promotion_id OR NEW.id IS DISTINCT FROM OLD.id OR
     NEW.code_lookup_digest IS DISTINCT FROM OLD.code_lookup_digest OR
     NEW.display_code IS DISTINCT FROM OLD.display_code THEN
    RAISE EXCEPTION 'voucher_identity_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON COLUMN myfin.promotion_vouchers.display_code IS
  'Normalized reusable marketing code shown to authorized staff and embedded in storefront links. NULL identifies a legacy hash-only code.';
COMMENT ON COLUMN myfin.promotion_vouchers.code_lookup_digest IS
  'HMAC-SHA-256 lookup digest used by checkout. Reusable public marketing codes may also be stored separately in display_code; legacy hash-only codes remain unrecoverable.';
COMMENT ON COLUMN myfin.promotion_voucher_versions.campaign_id IS
  'Optional stable campaign attribution. Runtime eligibility still requires that campaign current version to link the exact current promotion version.';
