CREATE TYPE "card_payment_rule" AS ENUM ('full', 'planned', 'interest_saving');
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "last_payment_cents" bigint,
  ADD COLUMN "last_payment_date" date,
  ADD COLUMN "card_payment_rule" "card_payment_rule" NOT NULL DEFAULT 'full',
  ADD COLUMN "card_planned_payment_cents" bigint;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_planned_payment_valid" CHECK (
  (card_planned_payment_cents IS NULL OR card_planned_payment_cents >= 0)
  AND (card_payment_rule <> 'planned' OR card_planned_payment_cents IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "bill_setup" ADD COLUMN "paid_from_external" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "bill_setup" ADD CONSTRAINT "bill_setup_paid_from_exclusive" CHECK (NOT paid_from_external OR account_id IS NULL);
--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD COLUMN "payment_override_cents" bigint;
--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD CONSTRAINT "bill_occurrences_payment_override_nonnegative" CHECK (payment_override_cents IS NULL OR payment_override_cents >= 0);
