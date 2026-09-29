-- Fulfillment is a separate, mutable workflow linked to an immutable paid POS sale.
-- Historical receipts have no known fulfillment state: keep them out of the new queue.
CREATE TABLE myfin.orders (
  company_id text NOT NULL,
  id text NOT NULL,
  client_id text,
  customer_name text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('pending','preparing','ready','completed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  legacy boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (company_id,id),
  FOREIGN KEY (company_id,id) REFERENCES myfin.transactions(company_id,id) ON DELETE RESTRICT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX orders_active_idx ON myfin.orders(company_id,created_at DESC,id DESC)
  WHERE status <> 'completed';
CREATE INDEX orders_history_idx ON myfin.orders(company_id,created_at DESC,id DESC);

CREATE TABLE myfin.order_events (
  company_id text NOT NULL,
  id text NOT NULL,
  order_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor_id text NOT NULL REFERENCES myfin.app_identities(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  action text NOT NULL CHECK (action IN ('created','imported','status_changed')),
  from_status text CHECK (from_status IN ('pending','preparing','ready','completed')),
  to_status text NOT NULL CHECK (to_status IN ('pending','preparing','ready','completed')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,id),
  UNIQUE (company_id,request_id),
  UNIQUE (company_id,order_id,version),
  FOREIGN KEY (company_id,order_id) REFERENCES myfin.orders(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX order_events_order_idx ON myfin.order_events(company_id,order_id,created_at,id);
CREATE FUNCTION myfin.protect_order_events() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  RAISE EXCEPTION 'order_event_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_order_events BEFORE UPDATE OR DELETE ON myfin.order_events
  FOR EACH ROW EXECUTE FUNCTION myfin.protect_order_events();

INSERT INTO myfin.orders(company_id,id,client_id,customer_name,status,legacy,created_at,completed_at)
SELECT company_id,id,NULLIF(data->>'client_id',''),coalesce(data->>'customerName',''),
       'completed',true,
       CASE WHEN pg_input_is_valid(data->>'date','timestamptz')
            THEN (data->>'date')::timestamptz ELSE now() END,
       now()
FROM myfin.transactions WHERE source='pos';
INSERT INTO myfin.order_events(company_id,id,order_id,version,actor_id,request_id,request_digest,
                               action,to_status,note)
SELECT o.company_id,gen_random_uuid()::text,o.id,1,t.actor_id,o.id,repeat('0',64),
       'imported','completed','Historical POS sale imported as completed; original fulfillment state was not tracked.'
FROM myfin.orders o JOIN myfin.transactions t
  ON t.company_id=o.company_id AND t.id=o.id WHERE o.legacy;

-- Covers checkouts made by an older API instance during a rolling deployment.
-- The definer owns only this narrowly scoped insert and the function pins its search path.
CREATE FUNCTION myfin.create_pos_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path=pg_catalog,myfin AS $$
BEGIN
  IF NEW.source <> 'pos' THEN RETURN NEW; END IF;
  INSERT INTO myfin.orders(company_id,id,client_id,customer_name,status)
  VALUES(NEW.company_id,NEW.id,NULLIF(NEW.data->>'client_id',''),
         coalesce(NEW.data->>'customerName',''),'pending');
  INSERT INTO myfin.order_events(company_id,id,order_id,version,actor_id,request_id,request_digest,
                                 action,to_status)
  VALUES(NEW.company_id,gen_random_uuid()::text,NEW.id,1,NEW.actor_id,NEW.id,
         repeat('0',64),'created','pending');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION myfin.create_pos_order() FROM PUBLIC;
CREATE TRIGGER pos_order_after_insert AFTER INSERT ON myfin.transactions
  FOR EACH ROW EXECUTE FUNCTION myfin.create_pos_order();
