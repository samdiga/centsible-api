ALTER TABLE "bill_occurrences"
  ADD COLUMN "pending_transaction_id" uuid
  REFERENCES "transactions"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX "bill_occurrences_pending_txn_uniq"
  ON "bill_occurrences" ("pending_transaction_id");
