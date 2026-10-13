-- Manager-recorded sales are immutable posted financial facts, but remain
-- distinguishable from live POS receipts in storage, reports and the UI.
ALTER TABLE myfin.transactions DROP CONSTRAINT IF EXISTS transactions_source_check;
ALTER TABLE myfin.transactions ADD CONSTRAINT transactions_source_check
  CHECK(source IN ('manual','pos','manual_sale'));
ALTER TABLE myfin.transactions ADD CONSTRAINT posted_sale_fingerprint_required
  CHECK(source NOT IN ('pos','manual_sale') OR
    (fingerprint IS NOT NULL AND fingerprint ~ '^[0-9a-f]{64}$'));

CREATE OR REPLACE FUNCTION myfin.protect_pos() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF OLD.source='manual_sale' THEN
  RAISE EXCEPTION 'posted_sale_immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.source='pos' THEN
  IF TG_OP='UPDATE' THEN
   IF (to_jsonb(NEW)-'data')=(to_jsonb(OLD)-'data') AND
      (NEW.data-'project')=(OLD.data-'project') THEN
    RETURN NEW;
   END IF;
  END IF;
  RAISE EXCEPTION 'posted_sale_immutable' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

-- A late entry describes an already fulfilled sale. Keep it in order history,
-- never in the live preparation queue. Its business occurrence remains separate
-- from the later server-recorded timestamp held in the immutable transaction.
CREATE OR REPLACE FUNCTION myfin.create_pos_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin AS $$
DECLARE occurred timestamptz;
BEGIN
  IF NEW.source NOT IN ('pos','manual_sale') THEN RETURN NEW; END IF;
  occurred:=CASE WHEN pg_input_is_valid(NEW.data->>'date','timestamptz')
    THEN (NEW.data->>'date')::timestamptz ELSE now() END;
  INSERT INTO myfin.orders(company_id,id,client_id,customer_name,status,created_at,
    updated_at,completed_at)
  VALUES(NEW.company_id,NEW.id,NULLIF(NEW.data->>'client_id',''),
    coalesce(NEW.data->>'customerName',''),
    CASE WHEN NEW.source='manual_sale' THEN 'completed' ELSE 'pending' END,
    CASE WHEN NEW.source='manual_sale' THEN occurred ELSE now() END,
    now(),CASE WHEN NEW.source='manual_sale' THEN occurred ELSE NULL END);
  INSERT INTO myfin.order_events(company_id,id,order_id,version,actor_id,request_id,
    request_digest,action,to_status,note)
  VALUES(NEW.company_id,gen_random_uuid()::text,NEW.id,1,NEW.actor_id,NEW.id,
    repeat('0',64),'created',
    CASE WHEN NEW.source='manual_sale' THEN 'completed' ELSE 'pending' END,
    CASE WHEN NEW.source='manual_sale'
      THEN 'Sale was recorded after fulfillment and entered directly into completed order history.'
      ELSE '' END);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION myfin.create_pos_order() FROM PUBLIC;

CREATE INDEX transactions_manual_sale_date_idx
  ON myfin.transactions(company_id,(data->>'businessDate'))
  WHERE source='manual_sale';
