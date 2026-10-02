-- Immutable provenance for the one-time, reviewed import of the original MyFin
-- Firebase database. Runtime roles receive no grants on these tables.
CREATE TABLE myfin.original_firebase_import_runs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  source_project text NOT NULL CHECK (length(source_project) BETWEEN 1 AND 128),
  source_read_time timestamptz NOT NULL,
  source_files jsonb NOT NULL CHECK (jsonb_typeof(source_files) = 'object'),
  export_digest text NOT NULL CHECK (export_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_project, source_read_time, export_digest),
  UNIQUE (id,source_project)
);

CREATE TABLE myfin.original_firebase_source_records (
  import_run_id text NOT NULL,
  source_project text NOT NULL,
  source_path text NOT NULL CHECK (source_path ~ '^[^/]+/[^/]+$'),
  collection_name text NOT NULL,
  document_id text NOT NULL,
  source_company_id text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  source_payload_digest text NOT NULL CHECK (source_payload_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  decoded_data jsonb NOT NULL CHECK (jsonb_typeof(decoded_data) = 'object'),
  disposition text NOT NULL CHECK (disposition IN ('imported','review_only','metadata_only')),
  target_table text,
  target_company_id text,
  target_id text,
  anomalies jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(anomalies) = 'array'),
  PRIMARY KEY (import_run_id, source_path),
  FOREIGN KEY (import_run_id,source_project) REFERENCES myfin.original_firebase_import_runs(id,source_project) ON DELETE RESTRICT,
  UNIQUE (source_project, source_path),
  CHECK (
    (disposition = 'imported' AND target_table IS NOT NULL AND target_id IS NOT NULL) OR
    (disposition <> 'imported' AND target_table IS NULL AND target_id IS NULL)
  )
);
CREATE INDEX original_firebase_source_lookup_idx
  ON myfin.original_firebase_source_records(source_project,collection_name,document_id);

CREATE TABLE myfin.original_firebase_auth_profiles (
  import_run_id text NOT NULL REFERENCES myfin.original_firebase_import_runs(id) ON DELETE RESTRICT,
  source_uid text NOT NULL CHECK (length(source_uid) BETWEEN 1 AND 256),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('identity_only','metadata_only')),
  target_identity_id text,
  PRIMARY KEY (import_run_id,source_uid),
  CHECK ((disposition='identity_only') = (target_identity_id IS NOT NULL))
);

CREATE TABLE myfin.original_firebase_id_mappings (
  import_run_id text NOT NULL REFERENCES myfin.original_firebase_import_runs(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  source_company_id text NOT NULL DEFAULT '',
  source_id text NOT NULL,
  target_table text NOT NULL,
  target_company_id text NOT NULL DEFAULT '',
  target_id text NOT NULL,
  PRIMARY KEY (import_run_id,entity_type,source_company_id,source_id)
);
CREATE INDEX original_firebase_target_lookup_idx
  ON myfin.original_firebase_id_mappings(target_table,target_company_id,target_id);

CREATE FUNCTION myfin.protect_original_firebase_import() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'original_firebase_import_immutable' USING ERRCODE='23514';
END $$;

CREATE TRIGGER immutable_original_firebase_import_runs
  BEFORE UPDATE OR DELETE ON myfin.original_firebase_import_runs
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_original_firebase_import();
CREATE TRIGGER no_truncate_original_firebase_import_runs
  BEFORE TRUNCATE ON myfin.original_firebase_import_runs
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_original_firebase_import();
CREATE TRIGGER immutable_original_firebase_source_records
  BEFORE UPDATE OR DELETE ON myfin.original_firebase_source_records
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_original_firebase_import();
CREATE TRIGGER no_truncate_original_firebase_source_records
  BEFORE TRUNCATE ON myfin.original_firebase_source_records
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_original_firebase_import();
CREATE TRIGGER immutable_original_firebase_auth_profiles
  BEFORE UPDATE OR DELETE ON myfin.original_firebase_auth_profiles
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_original_firebase_import();
CREATE TRIGGER no_truncate_original_firebase_auth_profiles
  BEFORE TRUNCATE ON myfin.original_firebase_auth_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_original_firebase_import();
CREATE TRIGGER immutable_original_firebase_id_mappings
  BEFORE UPDATE OR DELETE ON myfin.original_firebase_id_mappings
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_original_firebase_import();
CREATE TRIGGER no_truncate_original_firebase_id_mappings
  BEFORE TRUNCATE ON myfin.original_firebase_id_mappings
  FOR EACH STATEMENT EXECUTE FUNCTION myfin.protect_original_firebase_import();

REVOKE ALL ON myfin.original_firebase_import_runs FROM PUBLIC;
REVOKE ALL ON myfin.original_firebase_source_records FROM PUBLIC;
REVOKE ALL ON myfin.original_firebase_auth_profiles FROM PUBLIC;
REVOKE ALL ON myfin.original_firebase_id_mappings FROM PUBLIC;
REVOKE ALL ON FUNCTION myfin.protect_original_firebase_import() FROM PUBLIC;

COMMENT ON TABLE myfin.original_firebase_source_records IS
  'Private immutable source ledger. Historical Firebase payloads may contain personal and embedded image data.';
COMMENT ON TABLE myfin.original_firebase_auth_profiles IS
  'Allowlisted Firebase Auth metadata only. Password hashes, tokens and credentials are never imported.';
