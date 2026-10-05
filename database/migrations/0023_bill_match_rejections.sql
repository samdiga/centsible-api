-- Payments the user unmatched from a bill occurrence; auto-match never
-- re-links these pairs. Additive: no existing rows change.
CREATE TABLE "bill_match_rejections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "bill_occurrence_id" uuid NOT NULL REFERENCES "bill_occurrences"("id") ON DELETE CASCADE,
  "transaction_id" uuid NOT NULL REFERENCES "transactions"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "bill_match_rejections_pair_uniq"
  ON "bill_match_rejections" ("bill_occurrence_id", "transaction_id");

CREATE INDEX "bill_match_rejections_user_idx"
  ON "bill_match_rejections" ("user_id");
