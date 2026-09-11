ALTER TABLE "inbound_webhook_events" ADD COLUMN "lease_token" text;
--> statement-breakpoint
UPDATE "inbound_webhook_events"
SET "attempts" = GREATEST("attempts", 0);
--> statement-breakpoint
UPDATE "inbound_webhook_events"
SET "status" = 'pending',
    "locked_by" = NULL,
    "lease_expires_at" = NULL,
    "processed_at" = NULL
WHERE "status" = 'processing'
  AND (
    "locked_by" IS NULL
    OR btrim("locked_by") = ''
    OR "lease_expires_at" IS NULL
    OR NOT isfinite("lease_expires_at")
  );
--> statement-breakpoint
UPDATE "inbound_webhook_events"
SET "lease_token" = gen_random_uuid()::text
WHERE "status" = 'processing';
--> statement-breakpoint
UPDATE "inbound_webhook_events"
SET "locked_by" = NULL,
    "lease_expires_at" = NULL,
    "lease_token" = NULL
WHERE "status" <> 'processing';
--> statement-breakpoint
ALTER TABLE "inbound_webhook_events"
  ADD CONSTRAINT "inbound_webhook_events_attempts_check"
  CHECK ("attempts" >= 0);
--> statement-breakpoint
ALTER TABLE "inbound_webhook_events"
  ADD CONSTRAINT "inbound_webhook_events_lease_check"
  CHECK (
    (
      "status" = 'processing'
      AND "locked_by" IS NOT NULL
      AND btrim("locked_by") <> ''
      AND "lease_expires_at" IS NOT NULL
      AND isfinite("lease_expires_at")
      AND "lease_token" IS NOT NULL
      AND "lease_token" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    OR (
      "status" <> 'processing'
      AND "locked_by" IS NULL
      AND "lease_expires_at" IS NULL
      AND "lease_token" IS NULL
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_lease_token_uniq"
  ON "inbound_webhook_events" ("lease_token")
  WHERE "lease_token" IS NOT NULL;
