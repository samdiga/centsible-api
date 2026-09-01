ALTER TABLE "forecast_events" ADD COLUMN "recurring_series_id" uuid;--> statement-breakpoint
ALTER TABLE "forecast_events" ADD COLUMN "source_type" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "materialization_horizon_months" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "forecast_events" ADD CONSTRAINT "forecast_events_recurring_series_id_recurring_series_id_fk" FOREIGN KEY ("recurring_series_id") REFERENCES "public"."recurring_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forecast_events_recurring_series_date_idx" ON "forecast_events" USING btree ("recurring_series_id","date");