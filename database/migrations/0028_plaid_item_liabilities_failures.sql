-- Consecutive /liabilities/get failures whose reason says nothing about what
-- the bank will share (e.g. Plaid's INTERNAL_SERVER_ERROR). Reset by a fetch
-- that works or one that records liabilities_status. Additive.
ALTER TABLE "plaid_items"
  ADD COLUMN "liabilities_failures" integer DEFAULT 0 NOT NULL;
