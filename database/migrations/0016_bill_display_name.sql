-- Additive only: a user's name for a bill, kept apart from canonical_name,
-- which detection and statement sync match on. Rollback leaves the column.
ALTER TABLE "bill_setup" ADD COLUMN IF NOT EXISTS "display_name" text;
