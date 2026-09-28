-- Existing records remain explicitly legacy; no historical financial facts are rewritten.
ALTER TABLE myfin.transactions ADD COLUMN document_state text NOT NULL DEFAULT 'legacy' CHECK(document_state IN ('legacy','draft','issued','voided','corrected'));
ALTER TABLE myfin.transactions ADD COLUMN document_version integer NOT NULL DEFAULT 1;
ALTER TABLE myfin.transactions ADD COLUMN assigned_to text REFERENCES myfin.app_identities(id);
ALTER TABLE myfin.transactions ADD COLUMN issued_snapshot jsonb;
ALTER TABLE myfin.transactions ADD COLUMN issued_at timestamptz;
ALTER TABLE myfin.transactions ADD COLUMN correction_of text;
ALTER TABLE myfin.transactions ADD CONSTRAINT document_correction_fk FOREIGN KEY(company_id,correction_of) REFERENCES myfin.transactions(company_id,id);
CREATE TABLE myfin.document_number_sequences(company_id text REFERENCES myfin.companies(id),kind text NOT NULL,year integer NOT NULL,value integer NOT NULL,PRIMARY KEY(company_id,kind,year));
CREATE TABLE myfin.document_templates(id text PRIMARY KEY,company_id text NOT NULL REFERENCES myfin.companies(id),kind text NOT NULL CHECK(kind IN ('Invoice','Quote','Receipt')),name text NOT NULL,settings jsonb NOT NULL,version integer NOT NULL DEFAULT 1,published_version integer,actor_id text NOT NULL REFERENCES myfin.app_identities(id));
CREATE TABLE myfin.document_template_versions(template_id text REFERENCES myfin.document_templates(id),version integer NOT NULL,company_id text NOT NULL REFERENCES myfin.companies(id),kind text NOT NULL,name text NOT NULL,settings jsonb NOT NULL,published_at timestamptz NOT NULL DEFAULT now(),actor_id text NOT NULL REFERENCES myfin.app_identities(id),PRIMARY KEY(template_id,version));
CREATE TABLE myfin.document_template_defaults(company_id text REFERENCES myfin.companies(id),kind text NOT NULL,template_id text NOT NULL,version integer NOT NULL,PRIMARY KEY(company_id,kind),FOREIGN KEY(template_id,version) REFERENCES myfin.document_template_versions(template_id,version));
CREATE TABLE myfin.document_payments(id text PRIMARY KEY,company_id text NOT NULL,document_id text NOT NULL,actor_id text NOT NULL REFERENCES myfin.app_identities(id),amount numeric(18,2) NOT NULL CHECK(amount>0),method text NOT NULL,reference text NOT NULL DEFAULT '',paid_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(company_id,document_id) REFERENCES myfin.transactions(company_id,id));
CREATE TABLE myfin.document_events(id text PRIMARY KEY,company_id text NOT NULL,document_id text NOT NULL,actor_id text NOT NULL REFERENCES myfin.app_identities(id),action text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(company_id,document_id) REFERENCES myfin.transactions(company_id,id));
CREATE FUNCTION myfin.protect_issued_document() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF OLD.document_state IN ('issued','voided','corrected') THEN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['document_state','converted_to'])=(to_jsonb(OLD)-ARRAY['document_state','converted_to']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'issued_document_immutable' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER immutable_issued_document BEFORE UPDATE OR DELETE ON myfin.transactions FOR EACH ROW EXECUTE FUNCTION myfin.protect_issued_document();
CREATE INDEX document_owner_idx ON myfin.transactions(company_id,actor_id,document_state);
CREATE INDEX document_assignee_idx ON myfin.transactions(company_id,assigned_to,document_state);
