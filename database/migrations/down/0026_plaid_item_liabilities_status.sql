-- Explicit rollback only; never run automatically. Forgets which connections
-- need their Liabilities sharing re-approved; the next sync works it out again.
ALTER TABLE "plaid_items"
  DROP CONSTRAINT "plaid_items_liabilities_status_values",
  DROP COLUMN "liabilities_status";

DELETE FROM "__drizzle_migrations" WHERE hash = 'ddce78fcecdb0542c0ca69eb0ef1acceaf2237a41b832bf1a157fb0f097fc338';
