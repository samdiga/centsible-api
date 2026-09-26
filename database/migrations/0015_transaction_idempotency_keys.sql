-- Additive only: POST /transactions idempotency. Rollback leaves the table in place.
CREATE TABLE IF NOT EXISTS "transaction_idempotency_keys" (
  "user_id" uuid NOT NULL,
  "key" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "response" jsonb,
  "transaction_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "transaction_idempotency_keys_user_id_key_pk" PRIMARY KEY ("user_id", "key"),
  CONSTRAINT "transaction_idempotency_keys_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "transaction_idempotency_keys_transaction_id_transactions_id_fk"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL
);
