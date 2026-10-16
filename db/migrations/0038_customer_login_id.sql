-- Unverified email is contact data, not proof of global account ownership.
-- Give local customer accounts a separate Finn3 ID and stop reserving an email
-- address merely because an unverified registration supplied it.

ALTER TABLE myfin.customer_accounts
  ADD COLUMN login_id text;

-- Existing accounts keep their current sign-in identifier. Their email remains
-- explicitly unverified until a future verified identity provider is linked.
UPDATE myfin.customer_accounts
SET login_id=lower(primary_email)
WHERE login_id IS NULL;

ALTER TABLE myfin.customer_accounts
  ADD CONSTRAINT customer_accounts_login_id_shape CHECK(
    login_id IS NULL OR (
      length(login_id) BETWEEN 3 AND 254 AND
      login_id=lower(login_id) AND
      login_id ~ '^[a-z0-9][a-z0-9._+@-]*$'
    )
  );

DROP INDEX myfin.customer_accounts_email_key;
CREATE UNIQUE INDEX customer_accounts_login_id_key
  ON myfin.customer_accounts(lower(login_id))
  WHERE login_id IS NOT NULL;
CREATE INDEX customer_accounts_contact_email_idx
  ON myfin.customer_accounts(lower(primary_email))
  WHERE primary_email IS NOT NULL;

COMMENT ON COLUMN myfin.customer_accounts.login_id IS
  'Global local-login identifier. New IDs exclude @; migrated accounts with an email retain their prior email-shaped identifier. Contactless provider identities may remain null.';
COMMENT ON COLUMN myfin.customer_accounts.primary_email IS
  'Unverified contact address unless email_verified_at is set. It is not an account-ownership key and may be shared by unverified accounts.';
