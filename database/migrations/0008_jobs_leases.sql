ALTER TABLE "jobs" ADD COLUMN "locked_by" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_token" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_code" text;
--> statement-breakpoint
-- Active sync rows must have one unambiguous tenant identity before any
-- abandoned running row is requeued. Compare text values only so malformed
-- JSON tenant values cannot abort the cutover with a UUID cast error.
UPDATE "jobs"
SET
  "status" = 'failed',
  "error_code" = 'TENANT_IDENTITY_MISMATCH',
  "completed_at" = now(),
  "locked_by" = NULL,
  "lease_token" = NULL,
  "lease_expires_at" = NULL
WHERE "type" = 'sync_pipeline'
  AND "status" IN ('pending', 'running')
  AND (
    "user_id" IS NULL
    OR "payload"->>'userId' IS NULL
    OR "payload"->>'userId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR "user_id"::text <> "payload"->>'userId'
  );
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
CREATE INDEX "jobs_running_lease_expires_idx" ON "jobs" USING btree ("lease_expires_at") WHERE status = 'running';
