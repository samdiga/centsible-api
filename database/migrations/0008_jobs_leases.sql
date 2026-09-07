ALTER TABLE "jobs" ADD COLUMN "locked_by" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_token" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_code" text;
--> statement-breakpoint
-- Existing deployments have no lease token on running rows. Requeue rows with
-- attempts remaining and terminally fail exhausted rows before the new worker
-- starts; this also releases active-sync dedupe rows coherently.
UPDATE "jobs"
SET
  "status" = CASE WHEN "attempts" >= "max_attempts" THEN 'failed' ELSE 'pending' END,
  "scheduled_for" = CASE WHEN "attempts" >= "max_attempts" THEN "scheduled_for" ELSE now() END,
  "error_code" = CASE WHEN "attempts" >= "max_attempts" THEN 'LEGACY_RUNNING_EXHAUSTED' ELSE 'LEGACY_RUNNING_REQUEUED' END,
  "locked_by" = NULL,
  "lease_token" = NULL,
  "lease_expires_at" = NULL,
  "completed_at" = CASE WHEN "attempts" >= "max_attempts" THEN now() ELSE NULL END
WHERE "status" = 'running' AND "lease_token" IS NULL;
--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "error";
--> statement-breakpoint
CREATE INDEX "jobs_running_lease_expires_idx" ON "jobs" USING btree ("lease_expires_at") WHERE status = 'running';
