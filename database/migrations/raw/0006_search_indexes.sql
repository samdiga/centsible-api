CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS transactions_name_trgm_idx
  ON transactions USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS transactions_merchant_trgm_idx
  ON transactions USING gin (merchant_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS transactions_merchant_lower_idx
  ON transactions (user_id, lower(merchant_name));
