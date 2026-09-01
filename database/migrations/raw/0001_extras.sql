-- Raw SQL that Drizzle Kit can't express natively. Applied after the
-- generated migrations by `pnpm --filter @centsible/db migrate`. Per
-- docs/SCHEMA.md §3.

-- Enable pgvector for transaction embeddings (Phase 7+)
CREATE EXTENSION IF NOT EXISTS vector;

-- Vector column lives outside Drizzle's type system.
ALTER TABLE transaction_embeddings
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index for cosine similarity search.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'transaction_embeddings_embedding_hnsw'
  ) THEN
    CREATE INDEX transaction_embeddings_embedding_hnsw
      ON transaction_embeddings
      USING hnsw (embedding vector_cosine_ops);
  END IF;
END $$;

-- Self-referencing FKs that Drizzle couldn't declare at table creation.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'categories_parent_fk' AND table_name = 'categories'
  ) THEN
    ALTER TABLE categories
      ADD CONSTRAINT categories_parent_fk
      FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE categories VALIDATE CONSTRAINT categories_parent_fk;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'transactions_recurring_series_fk' AND table_name = 'transactions'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_recurring_series_fk
      FOREIGN KEY (recurring_series_id) REFERENCES bill_setup(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE transactions VALIDATE CONSTRAINT transactions_recurring_series_fk;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'transactions_parent_fk' AND table_name = 'transactions'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_parent_fk
      FOREIGN KEY (parent_transaction_id) REFERENCES transactions(id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE transactions VALIDATE CONSTRAINT transactions_parent_fk;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'transactions_duplicate_fk' AND table_name = 'transactions'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_duplicate_fk
      FOREIGN KEY (is_duplicate_of) REFERENCES transactions(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE transactions VALIDATE CONSTRAINT transactions_duplicate_fk;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'forecast_runs_scenario_fk' AND table_name = 'forecast_runs'
  ) THEN
    ALTER TABLE forecast_runs
      ADD CONSTRAINT forecast_runs_scenario_fk
      FOREIGN KEY (scenario_id) REFERENCES forecast_scenarios(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE forecast_runs VALIDATE CONSTRAINT forecast_runs_scenario_fk;
  END IF;
END $$;

-- Partial index for active (non-deleted) transactions — most queries hit this path.
CREATE INDEX IF NOT EXISTS transactions_user_date_active_idx
  ON transactions (user_id, date DESC)
  WHERE deleted_at IS NULL;

-- Partial index for pending transactions (small set, hot query in Cash Horizon).
CREATE INDEX IF NOT EXISTS transactions_user_pending_idx
  ON transactions (user_id, date DESC)
  WHERE status = 'pending' AND deleted_at IS NULL;

-- GIN index on merchant_patterns for bill matching.
CREATE INDEX IF NOT EXISTS bill_setup_merchant_patterns_gin
  ON bill_setup
  USING gin (merchant_patterns);

-- updated_at trigger function.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to every table that has updated_at.
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'users', 'household_members', 'plaid_items', 'accounts', 'manual_assets',
    'holdings', 'categories', 'transactions', 'rules', 'bill_setup',
    'budgets', 'budget_items', 'goals', 'forecast_scenarios', 'forecast_events',
    'ai_sessions', 'notification_preferences', 'feature_flags'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS set_updated_at_%I ON %I; '
      || 'CREATE TRIGGER set_updated_at_%I BEFORE UPDATE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      tbl, tbl, tbl, tbl
    );
  END LOOP;
END $$;

-- Row-level security stub (engaged when the app opens up to multiple users).
-- Enable per-table when ready:
--   ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY transactions_user_isolation ON transactions
--     USING (user_id = current_setting('app.current_user_id')::uuid);
