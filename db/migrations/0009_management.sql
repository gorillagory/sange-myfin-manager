-- Development management: immutable enrollment receipts and redacted lifecycle audit.
CREATE TABLE myfin.company_enrollments (
  enrollment_id uuid PRIMARY KEY,
  actor_id text NOT NULL REFERENCES myfin.app_identities(id),
  company_id text NOT NULL REFERENCES myfin.companies(id),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE myfin.management_events (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES myfin.app_identities(id),
  company_id text REFERENCES myfin.companies(id),
  subject_id text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX management_events_company_date_idx ON myfin.management_events(company_id,created_at DESC);
-- Runtime receives SELECT/INSERT only through the explicit development grant script.
