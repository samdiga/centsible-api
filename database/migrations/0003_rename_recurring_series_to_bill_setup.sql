-- Custom SQL migration file, put your code below! --
-- Rename recurring_series table to bill_setup
-- Postgres enum names are unchanged (recurring_status, recurring_cadence)
ALTER TABLE "recurring_series" RENAME TO "bill_setup";
--> statement-breakpoint
-- Update indexes to match new table name
ALTER INDEX "recurring_series_user_id_idx" RENAME TO "bill_setup_user_id_idx";
--> statement-breakpoint
ALTER INDEX "recurring_series_user_next_date_idx" RENAME TO "bill_setup_user_next_date_idx";
--> statement-breakpoint
ALTER INDEX "recurring_series_user_status_idx" RENAME TO "bill_setup_user_status_idx";