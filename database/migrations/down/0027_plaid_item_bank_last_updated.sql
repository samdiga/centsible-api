-- Explicit rollback only; never run automatically. Forgets when each bank
-- last refreshed; the next sync fills it in again.
ALTER TABLE "plaid_items"
  DROP COLUMN "bank_last_updated_at";

DELETE FROM "__drizzle_migrations" WHERE hash = '63b695eb53b9f3ad9be532667a3956a5949951bf0c7287130086ff5f7bb0a911';
