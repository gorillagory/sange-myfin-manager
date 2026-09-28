-- Preserve project grouping while every posted sale/stock/fingerprint field stays immutable.
CREATE OR REPLACE FUNCTION myfin.protect_pos() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF OLD.source='pos' THEN
  IF TG_OP='UPDATE' THEN
   IF (to_jsonb(NEW)-'data')=(to_jsonb(OLD)-'data') AND (NEW.data-'project')=(OLD.data-'project') THEN
    RETURN NEW;
   END IF;
  END IF;
  RAISE EXCEPTION 'posted_pos_immutable' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
