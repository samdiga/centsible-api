ALTER TABLE "accounts" ADD COLUMN "name_override" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "limit_override_cents" bigint;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "payment_due_date_override" date;
