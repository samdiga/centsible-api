CREATE TYPE "public"."pipeline_run_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pipeline_step_status" AS ENUM('pending', 'running', 'success', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."pipeline_trigger" AS ENUM('scheduled', 'manual', 'webhook');--> statement-breakpoint
CREATE TABLE "pipeline_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" "pipeline_step_status" DEFAULT 'pending' NOT NULL,
	"stats" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger" "pipeline_trigger" NOT NULL,
	"status" "pipeline_run_status" DEFAULT 'running' NOT NULL,
	"job_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"schedule_key" text NOT NULL,
	"hour" integer DEFAULT 6 NOT NULL,
	"minute" integer DEFAULT 0 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_dispatched_for" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_schedules_user_key_uniq" UNIQUE NULLS NOT DISTINCT("user_id","schedule_key")
);
--> statement-breakpoint
ALTER TABLE "pipeline_run_steps" ADD CONSTRAINT "pipeline_run_steps_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run_steps" ADD CONSTRAINT "pipeline_run_steps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_schedules" ADD CONSTRAINT "sync_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_run_steps_run_step_uniq" ON "pipeline_run_steps" USING btree ("run_id","step");--> statement-breakpoint
CREATE INDEX "pipeline_run_steps_user_idx" ON "pipeline_run_steps" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_user_started_idx" ON "pipeline_runs" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pipeline_runs_job_idx" ON "pipeline_runs" USING btree ("job_id");
-- NOTE: drizzle-kit's snapshot history was unaware of six unique indexes
-- (bill_setup_user_name_cadence_uniq, budgets_one_active_per_user_uniq,
-- categories_system_root_name_uniq, categories_system_sub_name_uniq,
-- categories_user_name_uniq, forecast_events_identity_uniq) that were
-- already applied out-of-band via drizzle/raw/0005_phase1_integrity_indexes.sql
-- and drizzle/raw/0006_search_indexes.sql. drizzle-kit generate re-emitted
-- CREATE UNIQUE INDEX statements for them here; they were removed from this
-- file (pre-existing drift, unrelated to the pipeline tables added in this
-- migration) since applying them again would fail with "already exists".