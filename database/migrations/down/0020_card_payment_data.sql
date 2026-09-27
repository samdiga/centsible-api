-- Explicit rollback only; never run automatically. Removes new user settings.
ALTER TABLE "bill_occurrences" DROP CONSTRAINT "bill_occurrences_payment_override_nonnegative", DROP COLUMN "payment_override_cents";
ALTER TABLE "bill_setup" DROP CONSTRAINT "bill_setup_paid_from_exclusive", DROP COLUMN "paid_from_external";
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_planned_payment_valid",
 DROP COLUMN "last_payment_cents", DROP COLUMN "last_payment_date",
 DROP COLUMN "card_payment_rule", DROP COLUMN "card_planned_payment_cents";
DROP TYPE "card_payment_rule";

DELETE FROM "__drizzle_migrations" WHERE hash = 'd9724f5e4cf32dcccbff90353ac6a50d6a4c449614ff02c54bee8620851409a4';
