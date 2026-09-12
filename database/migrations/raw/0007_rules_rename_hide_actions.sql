-- Rules Engine: two new actions. rename targets transactions.user_name
-- (existing column, previously unwritten by anything user-facing); hide
-- targets transactions.review_status = 'hidden' (existing enum value,
-- same story). Both nullable — unset means "this rule doesn't do that."
ALTER TABLE rules ADD COLUMN IF NOT EXISTS action_rename text;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS action_hide boolean;
