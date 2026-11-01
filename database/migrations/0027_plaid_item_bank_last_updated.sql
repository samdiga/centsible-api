-- When the bank last refreshed this connection's transactions at Plaid
-- (/item/get status.transactions.last_successful_update), as opposed to
-- last_sync_at, which is when we last asked Plaid. NULL until the first sync
-- after this lands, or when Plaid doesn't report it. Additive.
ALTER TABLE "plaid_items"
  ADD COLUMN "bank_last_updated_at" timestamp with time zone;
