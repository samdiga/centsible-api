-- Preserve the detection key when a user corrects a proposed schedule.
ALTER TABLE bill_setup ADD COLUMN IF NOT EXISTS cadence_override recurring_cadence;
