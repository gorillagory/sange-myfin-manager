-- Preserve reviewed cancellations as audit records instead of deleting paid intent.
ALTER TABLE myfin.receipt_reviews DROP CONSTRAINT receipt_reviews_status_check;
ALTER TABLE myfin.receipt_reviews ADD CONSTRAINT receipt_reviews_status_check CHECK(status IN ('pending','approved','dismissed'));
ALTER TABLE myfin.receipt_reviews ADD COLUMN dismissed_by text REFERENCES myfin.app_identities(id) ON DELETE RESTRICT;
ALTER TABLE myfin.receipt_reviews ADD COLUMN dismissal_reason text;
ALTER TABLE myfin.receipt_reviews ADD COLUMN dismissed_at timestamptz;

CREATE OR REPLACE FUNCTION myfin.protect_receipt_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF TG_OP='UPDATE' AND
    (to_jsonb(NEW)-ARRAY['status','approved_by','approval_reason','approved_at','dismissed_by','dismissal_reason','dismissed_at'])=
    (to_jsonb(OLD)-ARRAY['status','approved_by','approval_reason','approved_at','dismissed_by','dismissal_reason','dismissed_at']) AND
    ((NEW IS NOT DISTINCT FROM OLD) OR
      (OLD.status='pending' AND NEW.status='approved' AND NEW.approved_by IS NOT NULL AND length(trim(NEW.approval_reason))>=3 AND NEW.approved_at IS NOT NULL AND NEW.dismissed_by IS NULL AND NEW.dismissed_at IS NULL) OR
      (OLD.status='pending' AND NEW.status='dismissed' AND NEW.dismissed_by IS NOT NULL AND length(trim(NEW.dismissal_reason))>=3 AND NEW.dismissed_at IS NOT NULL AND NEW.approved_by IS NULL AND NEW.approved_at IS NULL))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'paid_intent_immutable' USING ERRCODE='23514';
END $$;
