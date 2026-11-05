-- A card or loan's statement bill takes its shown name from the account
-- (name_override, else the bank's name) through account_label, so renaming
-- the account renames the bill; display_name stays the user's own name for
-- it. canonical_name stays fixed: it also matches transactions to bills.
-- At most one live labelled bill per account. Additive.
ALTER TABLE "bill_setup" ADD COLUMN "account_label" text;
CREATE UNIQUE INDEX "bill_setup_user_account_label_uniq"
  ON "bill_setup" ("user_id", "to_account_id")
  WHERE "account_label" IS NOT NULL AND "deleted_at" IS NULL;
