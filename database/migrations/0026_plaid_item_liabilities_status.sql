-- What the bank said the last time Liabilities was fetched for a
-- connection: 'available', 'consent_required' (the user has to re-approve
-- sharing in Plaid's update mode) or 'not_supported'. NULL until the first
-- fetch, and for connections without a card or loan. Additive.
ALTER TABLE "plaid_items"
  ADD COLUMN "liabilities_status" text;

ALTER TABLE "plaid_items"
  ADD CONSTRAINT "plaid_items_liabilities_status_values"
    CHECK ("liabilities_status" IS NULL
      OR "liabilities_status" IN ('available', 'consent_required', 'not_supported'));
