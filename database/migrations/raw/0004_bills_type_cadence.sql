-- Raw SQL that Drizzle Kit can't express natively. Applied after the
-- generated migrations by `pnpm --filter @centsible/db migrate`. Per
-- docs/SCHEMA.md §3.

-- Add 'daily' to the recurring_cadence enum. This is idempotent via IF NOT EXISTS.
-- Note: ALTER TYPE ADD VALUE cannot be rolled back in Postgres (no-op on failure
-- is safer than transaction abort).
ALTER TYPE recurring_cadence ADD VALUE IF NOT EXISTS 'daily';

DO $$ BEGIN
  CREATE TYPE bill_type AS ENUM ('payable', 'transfer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE bill_setup
  ADD COLUMN IF NOT EXISTS bill_type bill_type NOT NULL DEFAULT 'payable';

ALTER TABLE bill_setup
  ADD COLUMN IF NOT EXISTS to_account_id uuid
  REFERENCES accounts(id) ON DELETE SET NULL;
