-- Explicit rollback only; never run automatically. Forgets each connection's
-- run of failed statement fetches; the count starts again from zero.
ALTER TABLE "plaid_items"
  DROP COLUMN "liabilities_failures";

DELETE FROM "__drizzle_migrations" WHERE hash = 'ccdfcba7bbfc443d2e53c15d3760640b9ed95d7a1b9a8f184cc2902ad10e765d';
