-- Prevent an issued row from being reset to draft to bypass its immutable facts.
CREATE OR REPLACE FUNCTION myfin.protect_issued_document() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF OLD.document_state IN ('issued','voided','corrected') THEN
  IF TG_OP='UPDATE' AND
     (to_jsonb(NEW)-ARRAY['document_state','converted_to'])=(to_jsonb(OLD)-ARRAY['document_state','converted_to']) AND
     ((OLD.document_state='issued' AND NEW.document_state IN ('issued','voided','corrected')) OR NEW.document_state=OLD.document_state) AND
     (NEW.converted_to IS NOT DISTINCT FROM OLD.converted_to OR
       (OLD.document_state='issued' AND NEW.document_state='issued' AND OLD.data->>'type'='Quote' AND OLD.converted_to IS NULL AND NEW.converted_to IS NOT NULL))
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'issued_document_immutable' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE FUNCTION myfin.protect_receipt_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF TG_OP='UPDATE' AND
    (to_jsonb(NEW)-ARRAY['status','approved_by','approval_reason','approved_at'])=(to_jsonb(OLD)-ARRAY['status','approved_by','approval_reason','approved_at']) AND
    ((NEW IS NOT DISTINCT FROM OLD) OR
      (OLD.status='pending' AND NEW.status='approved' AND NEW.approved_by IS NOT NULL AND length(trim(NEW.approval_reason))>=3 AND NEW.approved_at IS NOT NULL))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'paid_intent_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_paid_intent BEFORE UPDATE OR DELETE ON myfin.receipt_reviews FOR EACH ROW EXECUTE FUNCTION myfin.protect_receipt_review();
