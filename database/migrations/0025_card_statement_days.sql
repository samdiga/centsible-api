-- The user's statement day and payment due day for a card (day of month,
-- 1-31, clamped to short months). Used to work out the statement when the
-- bank link doesn't supply it (Transactions-only links). Additive.
ALTER TABLE "accounts"
  ADD COLUMN "statement_day" smallint,
  ADD COLUMN "payment_due_day" smallint;

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_statement_day_range"
    CHECK ("statement_day" IS NULL OR "statement_day" BETWEEN 1 AND 31),
  ADD CONSTRAINT "accounts_payment_due_day_range"
    CHECK ("payment_due_day" IS NULL OR "payment_due_day" BETWEEN 1 AND 31);
