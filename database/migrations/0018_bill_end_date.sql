-- Nullable additions preserve every existing bill and occurrence.
ALTER TABLE bill_setup ADD COLUMN IF NOT EXISTS end_date date;
ALTER TABLE bill_occurrences ADD COLUMN IF NOT EXISTS cancelled_by_end_date boolean;
