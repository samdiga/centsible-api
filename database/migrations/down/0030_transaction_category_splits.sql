-- Explicit rollback only; never run automatically. Removes every split: each
-- transaction falls back to its stored category_id (the largest line's).
DROP TABLE IF EXISTS "transaction_category_splits";
ALTER TABLE "transactions"
  DROP COLUMN "split_out_of_balance";

DELETE FROM "__drizzle_migrations" WHERE hash = 'c451083d5f66cee8dd0305a7855238c6e968a515ac549a497ae6455e66fb2dbb';
