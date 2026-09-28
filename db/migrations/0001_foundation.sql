-- IDs are opaque historical text, never silently converted to UUID or integer.
CREATE TABLE myfin.companies (
  id text PRIMARY KEY CHECK (length(id) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Application identity, not an authentication-provider credential/session table.
CREATE TABLE myfin.app_identities (
  id text PRIMARY KEY CHECK (length(id) > 0),
  display_name text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Namespace examples: firebase:<project-id>, later a vetted auth issuer.
-- Never infer identity linkage or privilege from an email address.
CREATE TABLE myfin.identity_mappings (
  provider text NOT NULL CHECK (length(provider) > 0),
  subject text NOT NULL CHECK (length(subject) > 0),
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identity_mappings_identity_idx ON myfin.identity_mappings(identity_id);

CREATE TABLE myfin.memberships (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('company_admin', 'company_user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, identity_id)
);
CREATE INDEX memberships_identity_idx ON myfin.memberships(identity_id);

COMMENT ON TABLE myfin.memberships IS
  'Future API must authorize each company operation from a verified identity. No global super grant is seeded or inferred.';
