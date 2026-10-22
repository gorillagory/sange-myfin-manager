-- A browser cannot discover a stable hardware identifier.  A terminal becomes
-- trusted only after an administrator creates it and a one-time enrollment
-- credential is claimed.  Only digests are retained after claim.
CREATE TABLE myfin.terminals (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  store_id text NOT NULL,
  store_location_id text NOT NULL,
  code text NOT NULL CHECK(code=upper(code) AND code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  type text NOT NULL DEFAULT 'pos' CHECK(type IN ('pos','kitchen_display','customer_display','back_office','print_connector','stock','multi_use')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','revoked','retired')),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(capabilities)='array'),
  device_profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(device_profile)='object'),
  credential_version integer NOT NULL DEFAULT 0 CHECK(credential_version>=0),
  last_seen_at timestamptz,
  enrolled_at timestamptz,
  revoked_at timestamptz,
  revoked_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,store_id,store_location_id,id),
  UNIQUE(company_id,code),
  FOREIGN KEY(company_id,store_id) REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,store_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,store_id,id) ON DELETE RESTRICT,
  CHECK(status<>'active' OR credential_version>0)
);

CREATE TABLE myfin.terminal_enrollment_credentials (
  token_digest text PRIMARY KEY CHECK(length(token_digest)=64),
  company_id text NOT NULL,
  terminal_id text NOT NULL,
  token_hint text NOT NULL CHECK(length(token_hint) BETWEEN 4 AND 12),
  created_by text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  revoked_at timestamptz,
  CHECK(expires_at>created_at),
  FOREIGN KEY(company_id,terminal_id) REFERENCES myfin.terminals(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX terminal_enrollment_terminal_idx ON myfin.terminal_enrollment_credentials(company_id,terminal_id,expires_at DESC);

CREATE TABLE myfin.terminal_credentials (
  company_id text NOT NULL,
  terminal_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  secret_digest text NOT NULL CHECK(length(secret_digest)=64),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY(company_id,terminal_id,version),
  UNIQUE(secret_digest),
  FOREIGN KEY(company_id,terminal_id) REFERENCES myfin.terminals(company_id,id) ON DELETE RESTRICT
);

CREATE TABLE myfin.terminal_login_guards (
  company_id text NOT NULL,
  terminal_id text NOT NULL,
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,terminal_id),
  FOREIGN KEY(company_id,terminal_id) REFERENCES myfin.terminals(company_id,id) ON DELETE RESTRICT
);

CREATE TABLE myfin.terminal_events (
  company_id text NOT NULL,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  terminal_id text NOT NULL,
  action text NOT NULL CHECK(length(action) BETWEEN 1 AND 80),
  actor_id text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,terminal_id) REFERENCES myfin.terminals(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX terminal_events_history_idx ON myfin.terminal_events(company_id,terminal_id,created_at DESC,id);

CREATE FUNCTION myfin.protect_terminal_event() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'terminal_event_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_terminal_event BEFORE UPDATE OR DELETE ON myfin.terminal_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_terminal_event();

ALTER TABLE myfin.pos_sessions
  ADD COLUMN terminal_id text,
  ADD COLUMN store_id text,
  ADD COLUMN store_location_id text,
  ADD COLUMN terminal_credential_version integer,
  ADD CONSTRAINT pos_sessions_terminal_fk FOREIGN KEY(company_id,terminal_id)
    REFERENCES myfin.terminals(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_terminal_context_fk FOREIGN KEY(company_id,store_id,store_location_id,terminal_id)
    REFERENCES myfin.terminals(company_id,store_id,store_location_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_terminal_credential_fk FOREIGN KEY(company_id,terminal_id,terminal_credential_version)
    REFERENCES myfin.terminal_credentials(company_id,terminal_id,version) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_store_fk FOREIGN KEY(company_id,store_id)
    REFERENCES myfin.stores(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_store_location_fk FOREIGN KEY(company_id,store_location_id)
    REFERENCES myfin.store_locations(company_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_sessions_terminal_context_shape CHECK(
    (terminal_id IS NULL AND store_id IS NULL AND store_location_id IS NULL AND terminal_credential_version IS NULL) OR
    (terminal_id IS NOT NULL AND store_id IS NOT NULL AND store_location_id IS NOT NULL AND terminal_credential_version>0));
CREATE INDEX pos_sessions_terminal_idx ON myfin.pos_sessions(company_id,terminal_id,expires_at DESC)
  WHERE terminal_id IS NOT NULL;
