-- Workspace tenancy, exact host routing, multi-company roles and POS-code sessions.
-- Existing company and financial identifiers remain unchanged.
CREATE TABLE myfin.workspaces (
  id text PRIMARY KEY CHECK (length(id) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  data jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
  suspended_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug)
);

ALTER TABLE myfin.companies ADD COLUMN workspace_id text;
ALTER TABLE myfin.companies ADD COLUMN slug text;
ALTER TABLE myfin.companies ADD COLUMN suspended_at timestamptz;

-- Each legacy company becomes an isolated workspace. This preserves scope while
-- allowing a workspace owner to add more brands after migration.
INSERT INTO myfin.workspaces(id,name,slug,data,created_at)
SELECT 'legacy-' || md5(c.id), c.name,
       CASE WHEN EXISTS (
         SELECT 1 FROM myfin.companies d
         WHERE d.id < c.id AND
           trim(both '-' from regexp_replace(lower(d.name),'[^a-z0-9]+','-','g')) =
           trim(both '-' from regexp_replace(lower(c.name),'[^a-z0-9]+','-','g'))
       ) THEN regexp_replace(left(coalesce(nullif(trim(both '-' from regexp_replace(lower(c.name),'[^a-z0-9]+','-','g')),''),'workspace'),54),'-+$','') || '-' || left(md5(c.id),8)
       ELSE regexp_replace(left(coalesce(nullif(trim(both '-' from regexp_replace(lower(c.name),'[^a-z0-9]+','-','g')),''),'workspace'),63),'-+$','')
       END,
       jsonb_build_object('migration','legacy-company-workspace'), c.created_at
FROM myfin.companies c;

UPDATE myfin.companies c SET
 workspace_id='legacy-' || md5(c.id),
 slug=regexp_replace(left(coalesce(nullif(trim(both '-' from regexp_replace(lower(c.name),'[^a-z0-9]+','-','g')),''),'company'),63),'-+$','');
ALTER TABLE myfin.companies ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE myfin.companies ALTER COLUMN slug SET NOT NULL;
ALTER TABLE myfin.companies ADD CONSTRAINT companies_workspace_fk FOREIGN KEY(workspace_id) REFERENCES myfin.workspaces(id) ON DELETE RESTRICT;
ALTER TABLE myfin.companies ADD CONSTRAINT companies_slug_check CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
ALTER TABLE myfin.companies ADD CONSTRAINT companies_workspace_slug_key UNIQUE(workspace_id,slug);
ALTER TABLE myfin.companies ADD CONSTRAINT companies_workspace_id_key UNIQUE(workspace_id,id);

CREATE TABLE myfin.workspace_memberships (
  workspace_id text NOT NULL REFERENCES myfin.workspaces(id) ON DELETE RESTRICT,
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK(role='workspace_owner'),
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,identity_id)
);
CREATE INDEX workspace_memberships_identity_idx ON myfin.workspace_memberships(identity_id);

INSERT INTO myfin.workspace_memberships(workspace_id,identity_id,role,created_at)
SELECT c.workspace_id,m.identity_id,'workspace_owner',m.created_at
FROM myfin.memberships m JOIN myfin.companies c ON c.id=m.company_id
WHERE m.role='company_admin'
ON CONFLICT DO NOTHING;

DROP INDEX myfin.membership_one_company_idx;
ALTER TABLE myfin.memberships DROP CONSTRAINT memberships_role_check;
UPDATE myfin.memberships SET role=CASE role WHEN 'company_admin' THEN 'manager' ELSE 'operator' END;
ALTER TABLE myfin.memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('manager','operator'));

CREATE TABLE myfin.tenant_hosts (
  hostname text PRIMARY KEY CHECK(hostname=lower(hostname) AND hostname ~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$'),
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  redirect_to text REFERENCES myfin.tenant_hosts(hostname) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_hosts_company_fk FOREIGN KEY(workspace_id,company_id) REFERENCES myfin.companies(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT tenant_hosts_shape_check CHECK((canonical AND redirect_to IS NULL) OR (NOT canonical AND redirect_to IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_hosts_canonical_company_idx ON myfin.tenant_hosts(company_id) WHERE canonical AND disabled_at IS NULL;

CREATE TABLE myfin.pos_access_codes (
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  lookup_digest text NOT NULL CHECK(length(lookup_digest)=64),
  salt text NOT NULL CHECK(length(salt)>=32),
  verifier text NOT NULL CHECK(length(verifier)>=64),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  disabled_at timestamptz,
  PRIMARY KEY(company_id,identity_id),
  UNIQUE(company_id,lookup_digest)
);

CREATE TABLE myfin.pos_login_guards (
  company_id text PRIMARY KEY REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE myfin.pos_sessions (
  token_digest text PRIMARY KEY CHECK(length(token_digest)=64),
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK(role IN ('manager','operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK(expires_at>created_at)
);
CREATE INDEX pos_sessions_identity_idx ON myfin.pos_sessions(identity_id,expires_at);

CREATE TABLE myfin.app_sessions (
  token_digest text PRIMARY KEY CHECK(length(token_digest)=64),
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  hostname text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK(expires_at>created_at)
);
CREATE INDEX app_sessions_identity_idx ON myfin.app_sessions(identity_id,expires_at);
CREATE TABLE myfin.session_handoffs (
  token_digest text PRIMARY KEY CHECK(length(token_digest)=64),
  identity_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  target_hostname text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '90 seconds',
  used_at timestamptz,
  CHECK(expires_at>created_at)
);

CREATE TABLE myfin.action_approvals (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES myfin.companies(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  approver_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason))>=3),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_approvals_company_date_idx ON myfin.action_approvals(company_id,created_at DESC);

ALTER TABLE myfin.expenses ADD COLUMN voided_at timestamptz;
ALTER TABLE myfin.expenses ADD COLUMN voided_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT;
ALTER TABLE myfin.expenses ADD COLUMN void_reason text;
ALTER TABLE myfin.expenses ADD COLUMN created_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT;
ALTER TABLE myfin.management_events ADD COLUMN workspace_id text REFERENCES myfin.workspaces(id) ON DELETE RESTRICT;

CREATE FUNCTION myfin.prevent_financial_delete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'financial_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_transaction_delete BEFORE DELETE ON myfin.transactions FOR EACH ROW EXECUTE FUNCTION myfin.prevent_financial_delete();
CREATE TRIGGER immutable_expense_delete BEFORE DELETE ON myfin.expenses FOR EACH ROW EXECUTE FUNCTION myfin.prevent_financial_delete();
