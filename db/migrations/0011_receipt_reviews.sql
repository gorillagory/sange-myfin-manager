CREATE TABLE myfin.receipt_reviews (
 company_id text NOT NULL REFERENCES myfin.companies(id),id text NOT NULL,actor_id text NOT NULL REFERENCES myfin.app_identities(id),
 payload jsonb NOT NULL,request_digest text NOT NULL CHECK(length(request_digest)=64),reason_code text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved')),approved_by text REFERENCES myfin.app_identities(id),approval_reason text,created_at timestamptz NOT NULL DEFAULT now(),approved_at timestamptz,
 PRIMARY KEY(company_id,id)
);
