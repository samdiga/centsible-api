-- Transaction splits (T-186): one transaction divided into category lines.
-- The transaction keeps its amount and a stored category_id (the largest
-- line's category, for readers that don't read lines and for older apps).
-- split_out_of_balance marks a split the bank's amount change broke; while it
-- is set, readers count the whole transaction under category_id. Additive.
CREATE TABLE "transaction_category_splits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "transaction_id" uuid NOT NULL REFERENCES "transactions"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category_id" uuid REFERENCES "categories"("id") ON DELETE SET NULL,
  "amount_cents" bigint NOT NULL,
  "position" smallint NOT NULL,
  "is_remainder" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "transaction_category_splits_amount_nonzero" CHECK ("amount_cents" <> 0),
  CONSTRAINT "transaction_category_splits_position_uniq" UNIQUE ("transaction_id", "position")
);
CREATE UNIQUE INDEX "transaction_category_splits_one_remainder"
  ON "transaction_category_splits" ("transaction_id") WHERE "is_remainder";
CREATE INDEX "transaction_category_splits_user_category_idx"
  ON "transaction_category_splits" ("user_id", "category_id");

ALTER TABLE "transactions"
  ADD COLUMN "split_out_of_balance" boolean NOT NULL DEFAULT false;
