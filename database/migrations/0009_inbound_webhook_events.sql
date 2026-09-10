CREATE TABLE "inbound_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"webhook_type" text NOT NULL,
	"webhook_code" text NOT NULL,
	"provider_item_id" text,
	"payload" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"locked_by" text,
	"last_error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "inbound_webhook_events_status_check" CHECK ("status" IN ('pending', 'processing', 'processed', 'dead'))
);
--> statement-breakpoint
CREATE INDEX "inbound_events_status_available_idx" ON "inbound_webhook_events" USING btree ("status", "available_at");
--> statement-breakpoint
CREATE INDEX "inbound_events_lease_expires_idx" ON "inbound_webhook_events" USING btree ("lease_expires_at");
--> statement-breakpoint
CREATE INDEX "inbound_events_provider_item_idx" ON "inbound_webhook_events" USING btree ("provider_item_id");
--> statement-breakpoint
CREATE INDEX "inbound_events_dedupe_idx" ON "inbound_webhook_events" USING btree ("dedupe_key");
