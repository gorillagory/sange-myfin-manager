-- Delayed retries are historical paid intents even when the device was online
-- at capture time. Allow an explicit recipe decision during their review while
-- keeping every other online receipt unable to attach historical recipe data.
ALTER TABLE myfin.receipt_reviews
  DROP CONSTRAINT receipt_reviews_recipe_resolution_context;
ALTER TABLE myfin.receipt_reviews
  ADD CONSTRAINT receipt_reviews_recipe_resolution_context CHECK(
    (inventory_recipe_resolution IS NULL OR
      (status='approved' AND
        (coalesce(payload->>'offline','false')='true' OR
          reason_code='receipt_review_required_delayed_sync'))) AND
    (status<>'approved' OR reason_code<>'receipt_review_required_recipe_timing' OR
      (coalesce(payload->>'offline','false')='true' AND
        inventory_recipe_resolution IS NOT NULL))
  );

CREATE OR REPLACE FUNCTION myfin.protect_receipt_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,myfin AS $$
BEGIN
 IF TG_OP='UPDATE' AND
    (to_jsonb(NEW)-ARRAY['status','approved_by','approval_reason','approved_at','dismissed_by',
      'dismissal_reason','dismissed_at','inventory_recipe_resolution'])=
    (to_jsonb(OLD)-ARRAY['status','approved_by','approval_reason','approved_at','dismissed_by',
      'dismissal_reason','dismissed_at','inventory_recipe_resolution']) AND
    ((NEW IS NOT DISTINCT FROM OLD) OR
      (OLD.status='pending' AND NEW.status='approved' AND NEW.approved_by IS NOT NULL AND
       length(trim(NEW.approval_reason))>=3 AND NEW.approved_at IS NOT NULL AND
       NEW.dismissed_by IS NULL AND NEW.dismissed_at IS NULL AND
       (NEW.inventory_recipe_resolution IS NULL OR
          coalesce(NEW.payload->>'offline','false')='true' OR
          NEW.reason_code='receipt_review_required_delayed_sync') AND
       (NEW.reason_code<>'receipt_review_required_recipe_timing' OR
          NEW.inventory_recipe_resolution IN ('current_recipe','captured_recipe'))) OR
      (OLD.status='pending' AND NEW.status='dismissed' AND NEW.dismissed_by IS NOT NULL AND
       length(trim(NEW.dismissal_reason))>=3 AND NEW.dismissed_at IS NOT NULL AND
       NEW.approved_by IS NULL AND NEW.approved_at IS NULL AND
       NEW.inventory_recipe_resolution IS NULL))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'paid_intent_immutable' USING ERRCODE='23514';
END $$;

COMMENT ON COLUMN myfin.receipt_reviews.inventory_recipe_resolution IS
  'Manager choice for an approved historical sale whose recipe boundary was found during submission or later approval; allowed for offline and delayed-sync reviews only.';
