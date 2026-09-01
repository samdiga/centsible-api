CREATE TYPE "public"."account_subtype" AS ENUM('checking', 'savings', 'money_market', 'cd', 'hsa', 'credit_card', 'line_of_credit', 'paypal', 'mortgage', 'auto', 'student', 'personal_loan', 'brokerage', 'ira', '401k', '403b', '529', 'roth', 'roth_401k', 'manual_home', 'manual_vehicle', 'crypto', 'cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('depository', 'credit', 'loan', 'investment', 'other');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'delete', 'bulk_update', 'revert', 'merge', 'split', 'sync');--> statement-breakpoint
CREATE TYPE "public"."budget_period" AS ENUM('monthly', 'biweekly', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."budget_style" AS ENUM('flex', 'category_zero_based');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."goal_type" AS ENUM('savings', 'purchase', 'debt_payoff', 'emergency_fund');--> statement-breakpoint
CREATE TYPE "public"."member_relationship" AS ENUM('self', 'partner', 'child', 'parent', 'roommate', 'other');--> statement-breakpoint
CREATE TYPE "public"."plaid_item_status" AS ENUM('active', 'login_required', 'pending_expiration', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."recurring_cadence" AS ENUM('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual', 'irregular');--> statement-breakpoint
CREATE TYPE "public"."recurring_status" AS ENUM('active', 'paused', 'ended', 'pending_confirmation');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('needs_review', 'reviewed', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."rollover_behavior" AS ENUM('none', 'roll_positive', 'roll_all');--> statement-breakpoint
CREATE TYPE "public"."rule_match_type" AS ENUM('merchant_exact', 'merchant_contains', 'name_contains', 'amount_exact', 'amount_range', 'combo');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('posted', 'pending', 'removed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plaid_item_id" uuid,
	"plaid_account_id" text,
	"name" text NOT NULL,
	"official_name" text,
	"type" "account_type" NOT NULL,
	"subtype" "account_subtype" NOT NULL,
	"mask" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"current_balance_cents" bigint,
	"available_balance_cents" bigint,
	"limit_cents" bigint,
	"apr" real,
	"apy" real,
	"minimum_payment_cents" bigint,
	"payment_due_date" date,
	"statement_balance_cents" bigint,
	"statement_date" date,
	"origination_date" date,
	"maturity_date" date,
	"color" text,
	"icon" text,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"exclude_from_net_worth" boolean DEFAULT false NOT NULL,
	"exclude_from_budgets" boolean DEFAULT false NOT NULL,
	"exclude_from_forecast" boolean DEFAULT false NOT NULL,
	"default_member_id" uuid,
	"display_order" integer DEFAULT 0 NOT NULL,
	"balance_last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "accounts_plaid_account_id_unique" UNIQUE("plaid_account_id")
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"model" text,
	"prompt_version" text,
	"tool_calls" jsonb,
	"citations" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"latency_ms" integer,
	"confidence" real,
	"guardrail_flags" jsonb,
	"user_feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"source" text NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"household_member_id" uuid,
	"amount_cents" bigint NOT NULL,
	"rollover_behavior" "rollover_behavior" DEFAULT 'none' NOT NULL,
	"rollover_balance_cents" bigint DEFAULT 0 NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text DEFAULT 'My Budget' NOT NULL,
	"style" "budget_style" DEFAULT 'flex' NOT NULL,
	"period" "budget_period" DEFAULT 'monthly' NOT NULL,
	"start_date" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"parent_id" uuid,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"is_income" boolean DEFAULT false NOT NULL,
	"is_transfer" boolean DEFAULT false NOT NULL,
	"exclude_from_budgets" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"flag_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"variant" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecast_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"name" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" date NOT NULL,
	"category_id" uuid,
	"note" text,
	"resolved_to_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "forecast_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"horizon_days" integer NOT NULL,
	"algorithm_version" text NOT NULL,
	"scenario_id" uuid,
	"start_balance_cents" bigint NOT NULL,
	"end_balance_p50_cents" bigint NOT NULL,
	"min_balance_p10_cents" bigint NOT NULL,
	"min_balance_date" date NOT NULL,
	"daily_results" jsonb NOT NULL,
	"actual_end_balance_cents" bigint,
	"mape" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecast_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goal_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid,
	"amount_cents" bigint NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"is_manual" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "goal_type" NOT NULL,
	"target_amount_cents" bigint NOT NULL,
	"current_amount_cents" bigint DEFAULT 0 NOT NULL,
	"target_date" date,
	"linked_account_id" uuid,
	"linked_category_id" uuid,
	"linked_debt_account_id" uuid,
	"member_allocations" jsonb,
	"auto_contribute_monthly_cents" bigint,
	"auto_contribute_from_category_id" uuid,
	"photo_url" text,
	"emoji" text,
	"color" text,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"completed_at" timestamp with time zone,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"plaid_security_id" text,
	"ticker" text,
	"name" text NOT NULL,
	"security_type" text,
	"quantity" real NOT NULL,
	"cost_basis_cents" bigint,
	"current_price_cents" bigint,
	"current_value_cents" bigint,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"price_last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"avatar_emoji" text,
	"avatar_color" text,
	"avatar_image_url" text,
	"relationship" "member_relationship" DEFAULT 'self' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"value_cents" bigint NOT NULL,
	"acquisition_date" date,
	"appreciation_rate_per_year" real,
	"notes" text,
	"is_liability" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "net_worth_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"total_assets_cents" bigint NOT NULL,
	"total_liabilities_cents" bigint NOT NULL,
	"net_worth_cents" bigint NOT NULL,
	"liquid_assets_cents" bigint NOT NULL,
	"breakdown" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"daily_digest_enabled" boolean DEFAULT true NOT NULL,
	"daily_digest_hour" integer DEFAULT 9 NOT NULL,
	"low_balance_alerts_enabled" boolean DEFAULT true NOT NULL,
	"low_balance_threshold_cents" bigint DEFAULT 10000 NOT NULL,
	"bill_reminders_enabled" boolean DEFAULT true NOT NULL,
	"bill_reminder_days_ahead" integer DEFAULT 3 NOT NULL,
	"large_transaction_alerts_enabled" boolean DEFAULT true NOT NULL,
	"large_transaction_threshold_cents" bigint DEFAULT 20000 NOT NULL,
	"price_change_alerts_enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" integer DEFAULT 22 NOT NULL,
	"quiet_hours_end" integer DEFAULT 7 NOT NULL,
	"push_token" text,
	"push_platform" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"push_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plaid_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plaid_item_id" text NOT NULL,
	"institution_id" text NOT NULL,
	"institution_name" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"access_token_nonce" text NOT NULL,
	"cursor" text,
	"status" "plaid_item_status" DEFAULT 'active' NOT NULL,
	"error_code" text,
	"error_message" text,
	"available_products" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"billed_products" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consented_products" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_webhook_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "plaid_items_plaid_item_id_unique" UNIQUE("plaid_item_id")
);
--> statement-breakpoint
CREATE TABLE "plaid_raw_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plaid_item_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"cursor" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"category_id" uuid,
	"canonical_name" text NOT NULL,
	"merchant_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_income" boolean DEFAULT false NOT NULL,
	"cadence" "recurring_cadence" NOT NULL,
	"day_of_month" integer,
	"day_of_week" integer,
	"avg_amount_cents" bigint NOT NULL,
	"std_dev_amount_cents" bigint DEFAULT 0 NOT NULL,
	"last_amount_cents" bigint,
	"last_occurred_on" date,
	"next_expected_date" date,
	"confidence" real DEFAULT 0 NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"status" "recurring_status" DEFAULT 'pending_confirmation' NOT NULL,
	"user_confirmed" boolean DEFAULT false NOT NULL,
	"auto_detected" boolean DEFAULT true NOT NULL,
	"notes" text,
	"last_price_change_at" timestamp with time zone,
	"previous_avg_amount_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"match_type" "rule_match_type" NOT NULL,
	"match_merchant" text,
	"match_name_contains" text,
	"match_amount_min_cents" bigint,
	"match_amount_max_cents" bigint,
	"match_account_id" uuid,
	"action_category_id" uuid,
	"action_member_id" uuid,
	"action_set_notes" text,
	"action_add_tags" jsonb,
	"action_mark_reviewed" boolean,
	"action_exclude_from_budgets" boolean,
	"is_active" boolean DEFAULT true NOT NULL,
	"apply_to_existing" boolean DEFAULT false NOT NULL,
	"last_applied_at" timestamp with time zone,
	"times_applied" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_embeddings" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"household_member_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"percentage" real,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_tags" (
	"transaction_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_tags_transaction_id_tag_id_pk" PRIMARY KEY("transaction_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"plaid_transaction_id" text,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"date" date NOT NULL,
	"authorized_date" date,
	"status" "transaction_status" DEFAULT 'posted' NOT NULL,
	"name" text NOT NULL,
	"merchant_name" text,
	"payment_channel" text,
	"plaid_category_primary" text,
	"plaid_category_detailed" text,
	"plaid_category_confidence" text,
	"category_id" uuid,
	"user_category_override" boolean DEFAULT false NOT NULL,
	"user_name" text,
	"notes" text,
	"household_member_id" uuid,
	"recurring_series_id" uuid,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"is_split" boolean DEFAULT false NOT NULL,
	"parent_transaction_id" uuid,
	"review_status" "review_status" DEFAULT 'needs_review' NOT NULL,
	"exclude_from_budgets" boolean DEFAULT false NOT NULL,
	"exclude_from_reports" boolean DEFAULT false NOT NULL,
	"is_duplicate_of" uuid,
	"location" jsonb,
	"payment_meta" jsonb,
	"plaid_raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "transactions_plaid_transaction_id_unique" UNIQUE("plaid_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"auth_provider_id" text,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_auth_provider_id_unique" UNIQUE("auth_provider_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plaid_item_id_plaid_items_id_fk" FOREIGN KEY ("plaid_item_id") REFERENCES "public"."plaid_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_default_member_id_household_members_id_fk" FOREIGN KEY ("default_member_id") REFERENCES "public"."household_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_items" ADD CONSTRAINT "budget_items_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_items" ADD CONSTRAINT "budget_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_items" ADD CONSTRAINT "budget_items_household_member_id_household_members_id_fk" FOREIGN KEY ("household_member_id") REFERENCES "public"."household_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_events" ADD CONSTRAINT "forecast_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_events" ADD CONSTRAINT "forecast_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_events" ADD CONSTRAINT "forecast_events_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_events" ADD CONSTRAINT "forecast_events_resolved_to_transaction_id_transactions_id_fk" FOREIGN KEY ("resolved_to_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_scenarios" ADD CONSTRAINT "forecast_scenarios_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_linked_account_id_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_linked_category_id_categories_id_fk" FOREIGN KEY ("linked_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_linked_debt_account_id_accounts_id_fk" FOREIGN KEY ("linked_debt_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_auto_contribute_from_category_id_categories_id_fk" FOREIGN KEY ("auto_contribute_from_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_assets" ADD CONSTRAINT "manual_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "net_worth_snapshots" ADD CONSTRAINT "net_worth_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_items" ADD CONSTRAINT "plaid_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_raw_imports" ADD CONSTRAINT "plaid_raw_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_raw_imports" ADD CONSTRAINT "plaid_raw_imports_plaid_item_id_plaid_items_id_fk" FOREIGN KEY ("plaid_item_id") REFERENCES "public"."plaid_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_match_account_id_accounts_id_fk" FOREIGN KEY ("match_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_action_category_id_categories_id_fk" FOREIGN KEY ("action_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_action_member_id_household_members_id_fk" FOREIGN KEY ("action_member_id") REFERENCES "public"."household_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_embeddings" ADD CONSTRAINT "transaction_embeddings_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_embeddings" ADD CONSTRAINT "transaction_embeddings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_household_member_id_household_members_id_fk" FOREIGN KEY ("household_member_id") REFERENCES "public"."household_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD CONSTRAINT "transaction_tags_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD CONSTRAINT "transaction_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_household_member_id_household_members_id_fk" FOREIGN KEY ("household_member_id") REFERENCES "public"."household_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_plaid_item_id_idx" ON "accounts" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE INDEX "accounts_type_idx" ON "accounts" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "ai_messages_session_id_idx" ON "ai_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ai_messages_user_id_idx" ON "ai_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_sessions_user_id_idx" ON "ai_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_user_entity_idx" ON "audit_log" USING btree ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_user_created_idx" ON "audit_log" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "budget_items_budget_id_idx" ON "budget_items" USING btree ("budget_id");--> statement-breakpoint
CREATE INDEX "budget_items_category_id_idx" ON "budget_items" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_items_unique_tuple" ON "budget_items" USING btree ("budget_id","category_id","household_member_id");--> statement-breakpoint
CREATE INDEX "budgets_user_id_idx" ON "budgets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budgets_user_active_idx" ON "budgets" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "categories_user_id_idx" ON "categories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "categories_parent_id_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_user_flag_idx" ON "feature_flags" USING btree ("user_id","flag_key");--> statement-breakpoint
CREATE INDEX "forecast_events_user_date_idx" ON "forecast_events" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "forecast_runs_user_id_idx" ON "forecast_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "forecast_runs_user_created_idx" ON "forecast_runs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "forecast_scenarios_user_id_idx" ON "forecast_scenarios" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "goal_contributions_goal_id_idx" ON "goal_contributions" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "goal_contributions_user_id_idx" ON "goal_contributions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "goals_user_id_idx" ON "goals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "goals_user_status_idx" ON "goals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "holdings_user_id_idx" ON "holdings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "holdings_account_id_idx" ON "holdings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "household_members_user_id_idx" ON "household_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_status_scheduled_idx" ON "jobs" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "jobs_user_type_idx" ON "jobs" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "manual_assets_user_id_idx" ON "manual_assets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "net_worth_snapshots_user_date_idx" ON "net_worth_snapshots" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "plaid_items_user_id_idx" ON "plaid_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plaid_items_status_idx" ON "plaid_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plaid_raw_imports_user_created_idx" ON "plaid_raw_imports" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recurring_series_user_id_idx" ON "recurring_series" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recurring_series_user_next_date_idx" ON "recurring_series" USING btree ("user_id","next_expected_date");--> statement-breakpoint
CREATE INDEX "recurring_series_user_status_idx" ON "recurring_series" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "rules_user_priority_idx" ON "rules" USING btree ("user_id","priority");--> statement-breakpoint
CREATE INDEX "rules_user_active_idx" ON "rules" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_name_idx" ON "tags" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "transaction_embeddings_user_id_idx" ON "transaction_embeddings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transaction_splits_transaction_id_idx" ON "transaction_splits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_splits_member_id_idx" ON "transaction_splits" USING btree ("household_member_id");--> statement-breakpoint
CREATE INDEX "transactions_user_date_idx" ON "transactions" USING btree ("user_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_user_account_date_idx" ON "transactions" USING btree ("user_id","account_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_user_category_date_idx" ON "transactions" USING btree ("user_id","category_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_user_member_date_idx" ON "transactions" USING btree ("user_id","household_member_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_user_review_idx" ON "transactions" USING btree ("user_id","review_status");--> statement-breakpoint
CREATE INDEX "transactions_merchant_idx" ON "transactions" USING btree ("user_id","merchant_name");--> statement-breakpoint
CREATE INDEX "transactions_recurring_series_idx" ON "transactions" USING btree ("recurring_series_id");--> statement-breakpoint
CREATE INDEX "transactions_parent_idx" ON "transactions" USING btree ("parent_transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_user_status_date_idx" ON "transactions" USING btree ("user_id","status","date" DESC NULLS LAST);