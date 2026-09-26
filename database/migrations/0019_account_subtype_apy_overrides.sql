-- Additive only: the user's checking/savings choice and savings rate for a
-- bank-linked account, kept apart from what Plaid reports so syncs never
-- overwrite them. Rollback leaves the columns in place.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "subtype_override" "account_subtype";
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "apy_override" real;
