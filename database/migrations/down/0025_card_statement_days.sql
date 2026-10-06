-- Explicit rollback only; never run automatically. Removes the user's card
-- statement and due days; cards without bank statement data lose their bill.
ALTER TABLE "accounts"
  DROP CONSTRAINT "accounts_payment_due_day_range",
  DROP CONSTRAINT "accounts_statement_day_range",
  DROP COLUMN "payment_due_day",
  DROP COLUMN "statement_day";

DELETE FROM "__drizzle_migrations" WHERE hash = '939b85967940966cb98a8d0a204b73b3998ab23bf73becf3de22186feeedb3c4';
