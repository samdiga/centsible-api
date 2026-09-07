ALTER TABLE "jobs" ADD COLUMN "locked_by" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_token" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_code" text;
--> statement-breakpoint
CREATE INDEX "jobs_running_lease_expires_idx" ON "jobs" USING btree ("lease_expires_at") WHERE status = 'running';
