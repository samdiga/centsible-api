-- Explicit rollback only; never run automatically. Card bills fall back to
-- display_name or canonical_name; a display name the label replaced (one equal
-- to the account's name) is not restored.
DROP INDEX IF EXISTS "bill_setup_user_account_label_uniq";
ALTER TABLE "bill_setup"
  DROP COLUMN "account_label";

DELETE FROM "__drizzle_migrations" WHERE hash = '00d087b09b93df77f695cc846e74535f6c68952f080ad64f21734d1c45b7f3b0';
