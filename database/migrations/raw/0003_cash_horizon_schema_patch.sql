-- The unique index on (user_id, flag_key) never fires for global rows because
-- NULL user_ids compare distinct, so global flags need their own partial unique
-- index. Dedupe first (keep the most recently updated row per flag_key) so the
-- index can be created on databases that already accumulated duplicates.
DELETE FROM feature_flags f
USING feature_flags keep
WHERE f.user_id IS NULL
  AND keep.user_id IS NULL
  AND f.flag_key = keep.flag_key
  AND (f.updated_at, f.id) < (keep.updated_at, keep.id);

CREATE UNIQUE INDEX IF NOT EXISTS feature_flags_flag_key_global_uniq
  ON feature_flags (flag_key)
  WHERE user_id IS NULL;

-- Seed the Cash Horizon feature flag (global, no user_id).
-- This flag gates the /forecast API route via isEnabled('cash_horizon_v1', userId).
-- Insert with enabled = false by default; flip to true to release the feature.
INSERT INTO feature_flags (flag_key, enabled)
VALUES ('cash_horizon_v1', false)
ON CONFLICT (flag_key) WHERE user_id IS NULL DO NOTHING;

-- Partial unique index for idempotent materialization upsert.
-- ON CONFLICT (recurring_series_id, date) DO NOTHING works against this index
-- for rows where recurring_series_id IS NOT NULL and deleted_at IS NULL.
CREATE UNIQUE INDEX IF NOT EXISTS forecast_events_series_date_uniq
  ON forecast_events (recurring_series_id, date)
  WHERE recurring_series_id IS NOT NULL AND deleted_at IS NULL;

-- Replace the CASCADE FK from the Drizzle-generated migration with SET NULL.
-- Deleting a recurring series should null out the reference on forecast_events,
-- not cascade-delete the forward projection history.
ALTER TABLE forecast_events
  DROP CONSTRAINT IF EXISTS forecast_events_recurring_series_id_recurring_series_id_fk;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'forecast_events_recurring_series_fk'
      AND table_name = 'forecast_events'
  ) THEN
    ALTER TABLE forecast_events
      ADD CONSTRAINT forecast_events_recurring_series_fk
        FOREIGN KEY (recurring_series_id) REFERENCES bill_setup(id) ON DELETE SET NULL;
  END IF;
END $$;
