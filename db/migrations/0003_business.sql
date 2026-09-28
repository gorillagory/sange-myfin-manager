CREATE TABLE myfin.products (
 company_id text NOT NULL REFERENCES myfin.companies(id), id text NOT NULL,
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
 stock numeric(18,3) NOT NULL CHECK(stock BETWEEN -1000000000 AND 1000000000),
 price numeric(18,4) NOT NULL CHECK(price BETWEEN 0 AND 1000000000),
 cost numeric(18,4) NOT NULL CHECK(cost BETWEEN 0 AND 1000000000),
 PRIMARY KEY(company_id,id), CHECK(length(id) BETWEEN 1 AND 128)
);
CREATE TABLE myfin.product_variants (
 company_id text NOT NULL, product_id text NOT NULL, id text NOT NULL,
 stock numeric(18,3) NOT NULL CHECK(stock BETWEEN -1000000000 AND 1000000000),
 price numeric(18,4) NOT NULL CHECK(price BETWEEN 0 AND 1000000000),
 cost numeric(18,4) NOT NULL CHECK(cost BETWEEN 0 AND 1000000000),
 PRIMARY KEY(company_id,product_id,id),
 FOREIGN KEY(company_id,product_id) REFERENCES myfin.products(company_id,id) ON DELETE CASCADE
);
CREATE TABLE myfin.clients (
 company_id text NOT NULL REFERENCES myfin.companies(id), id text NOT NULL,
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'), PRIMARY KEY(company_id,id)
);
CREATE TABLE myfin.transactions (
 company_id text NOT NULL REFERENCES myfin.companies(id), id text NOT NULL,
 actor_id text NOT NULL REFERENCES myfin.app_identities(id),
 source text NOT NULL CHECK(source IN ('manual','pos')),
 total numeric(18,2) NOT NULL CHECK(total BETWEEN 0 AND 1000000000000),
 fingerprint text, data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
 PRIMARY KEY(company_id,id), CHECK(source <> 'pos' OR length(fingerprint)=64)
);
CREATE TABLE myfin.expenses (
 company_id text NOT NULL REFERENCES myfin.companies(id), id text NOT NULL,
 amount numeric(18,2) NOT NULL CHECK(amount BETWEEN 0 AND 1000000000000),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'), PRIMARY KEY(company_id,id)
);
CREATE TABLE myfin.stock_movements (
 company_id text NOT NULL, id text NOT NULL, actor_id text NOT NULL REFERENCES myfin.app_identities(id),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'), PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,id) REFERENCES myfin.transactions(company_id,id)
);
CREATE TABLE myfin.activities (
 company_id text NOT NULL REFERENCES myfin.companies(id), id text NOT NULL,
 actor_id text NOT NULL REFERENCES myfin.app_identities(id),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id)
);
CREATE INDEX activities_date_idx ON myfin.activities(company_id,created_at DESC);
CREATE TABLE myfin.files (
 id text PRIMARY KEY, company_id text NOT NULL REFERENCES myfin.companies(id),
 actor_id text NOT NULL REFERENCES myfin.app_identities(id), kind text NOT NULL CHECK(kind IN ('products','receipts')),
 mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind <> 'products' OR (size<=3145728 AND mime<>'application/pdf'))
);
CREATE INDEX files_company_idx ON myfin.files(company_id,id);
CREATE FUNCTION myfin.protect_pos() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF OLD.source='pos' THEN RAISE EXCEPTION 'posted_pos_immutable' USING ERRCODE='23514'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER immutable_pos BEFORE UPDATE OR DELETE ON myfin.transactions FOR EACH ROW EXECUTE FUNCTION myfin.protect_pos();
