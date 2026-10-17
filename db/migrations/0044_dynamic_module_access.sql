-- Optional, company-scoped module allow-lists for manager and operator memberships.
-- A missing row preserves the role's application defaults; an empty array is an
-- intentional account with no operational modules. Workspace owners and
-- SuperAdmins are deliberately outside this table so they cannot be locked out.

CREATE TABLE myfin.membership_module_grants (
  company_id text NOT NULL,
  identity_id text NOT NULL,
  module_ids text[] NOT NULL,
  updated_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,identity_id),
  FOREIGN KEY(company_id,identity_id)
    REFERENCES myfin.memberships(company_id,identity_id) ON DELETE CASCADE,
  CHECK(array_position(module_ids,NULL) IS NULL),
  CHECK(cardinality(module_ids) <= 7),
  CHECK(module_ids <@ ARRAY[
    'workspace','inventory','finance','analytics','administration','settings','access'
  ]::text[])
);

COMMENT ON TABLE myfin.membership_module_grants IS
  'Explicit per-company module allow-list. Missing row means role defaults; empty module_ids means no modules. Role ceilings are revalidated by the application on every management write.';

CREATE INDEX membership_module_grants_identity_idx
  ON myfin.membership_module_grants(identity_id,company_id);
