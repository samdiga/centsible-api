CREATE TYPE "public"."forecast_event_source_type" AS ENUM('manual', 'recurring');--> statement-breakpoint
ALTER TABLE "forecast_events" DROP CONSTRAINT "forecast_events_recurring_series_id_recurring_series_id_fk";
--> statement-breakpoint
ALTER TABLE "forecast_events" ALTER COLUMN "source_type" SET DEFAULT 'manual'::"public"."forecast_event_source_type";--> statement-breakpoint
ALTER TABLE "forecast_events" ALTER COLUMN "source_type" SET DATA TYPE "public"."forecast_event_source_type" USING "source_type"::"public"."forecast_event_source_type";