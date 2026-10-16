-- Bind every marketing grant to the exact verified contact destination and
-- prepare phone verification without pretending that an OTP flow exists.
-- Existing grants have no destination evidence and therefore become
-- ineffective in application queries until the customer grants again after
-- verification. The NOT VALID constraint still enforces evidence on every new
-- grant without rewriting the immutable historic consent ledger.

ALTER TABLE myfin.customer_workspace_profiles
  ADD COLUMN phone_verified_at timestamptz,
  ADD CONSTRAINT customer_workspace_profiles_verified_phone CHECK(
    phone_verified_at IS NULL OR btrim(phone)<>''
  );

ALTER TABLE myfin.customer_sessions
  ADD COLUMN hostname text,
  ADD CONSTRAINT customer_sessions_exact_host CHECK(
    hostname IS NOT NULL AND length(hostname) BETWEEN 1 AND 253 AND
    hostname=lower(hostname) AND hostname !~ '[:/]'
  ) NOT VALID;

ALTER TABLE myfin.customer_consent_events
  ADD COLUMN destination text,
  ADD COLUMN destination_verified_at timestamptz,
  ADD CONSTRAINT customer_consent_events_destination_length CHECK(
    destination IS NULL OR length(destination) BETWEEN 1 AND 254
  ),
  ADD CONSTRAINT customer_consent_grant_has_verified_destination CHECK(
    NOT granted OR (destination IS NOT NULL AND destination_verified_at IS NOT NULL)
  ) NOT VALID;

COMMENT ON COLUMN myfin.customer_workspace_profiles.phone_verified_at IS
  'Set only by a future reviewed phone challenge. Customer profile edits clear it whenever the phone value changes.';
COMMENT ON COLUMN myfin.customer_sessions.hostname IS
  'Exact storefront audience for this host-only session. Pre-migration parent-domain sessions remain null and are rejected.';
COMMENT ON COLUMN myfin.customer_consent_events.destination IS
  'Exact email address or workspace phone number covered by this immutable marketing choice.';
COMMENT ON COLUMN myfin.customer_consent_events.destination_verified_at IS
  'Snapshot of destination verification at grant time. A grant is effective only while the current verified destination still matches.';
