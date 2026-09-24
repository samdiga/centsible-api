ALTER TABLE "notification_preferences" ADD COLUMN "sync_alerts_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "push_environment" text;
