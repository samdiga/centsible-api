CREATE TYPE "public"."bill_occurrence_status" AS ENUM('upcoming', 'overdue', 'processing', 'paid', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."bill_type" AS ENUM('payable', 'transfer');--> statement-breakpoint
ALTER TYPE "public"."recurring_cadence" ADD VALUE 'daily' BEFORE 'weekly';--> statement-breakpoint
CREATE TABLE "bill_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"bill_setup_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"status" "bill_occurrence_status" DEFAULT 'upcoming' NOT NULL,
	"expected_amount_cents" bigint NOT NULL,
	"paid_amount_cents" bigint,
	"paid_account_id" uuid,
	"linked_transaction_id" uuid,
	"marked_paid_at" timestamp with time zone,
	"confirmed_paid_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_setup" ADD COLUMN "bill_type" "bill_type" DEFAULT 'payable' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_setup" ADD COLUMN "to_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD CONSTRAINT "bill_occurrences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD CONSTRAINT "bill_occurrences_bill_setup_id_bill_setup_id_fk" FOREIGN KEY ("bill_setup_id") REFERENCES "public"."bill_setup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD CONSTRAINT "bill_occurrences_paid_account_id_accounts_id_fk" FOREIGN KEY ("paid_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD CONSTRAINT "bill_occurrences_linked_transaction_id_transactions_id_fk" FOREIGN KEY ("linked_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_occurrences_user_due_date_idx" ON "bill_occurrences" USING btree ("user_id","due_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bill_occurrences_user_setup_idx" ON "bill_occurrences" USING btree ("user_id","bill_setup_id");--> statement-breakpoint
CREATE INDEX "bill_occurrences_user_status_idx" ON "bill_occurrences" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "bill_occurrences_linked_txn_idx" ON "bill_occurrences" USING btree ("linked_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_occurrences_setup_due_date_uniq" ON "bill_occurrences" USING btree ("bill_setup_id","due_date");--> statement-breakpoint
ALTER TABLE "bill_setup" ADD CONSTRAINT "bill_setup_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;