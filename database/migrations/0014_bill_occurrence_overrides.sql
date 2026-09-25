ALTER TABLE "bill_occurrences" ADD COLUMN "occurrence_key" text;
ALTER TABLE "bill_occurrences" ADD COLUMN "expected_amount_override_cents" bigint;
ALTER TABLE "bill_occurrences" ADD COLUMN "due_date_override" date;
ALTER TABLE "forecast_events" ADD COLUMN "bill_occurrence_id" uuid;

UPDATE "bill_occurrences" AS occurrence
SET "occurrence_key" = occurrence."bill_setup_id"::text || ':' ||
  CASE WHEN setup."cadence" = 'monthly'
    THEN to_char(occurrence."due_date", 'YYYY-MM')
    ELSE occurrence."due_date"::text
  END
FROM "bill_setup" AS setup
WHERE setup."id" = occurrence."bill_setup_id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "bill_occurrences"
    GROUP BY "bill_setup_id", "occurrence_key"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate bill occurrence cycle keys';
  END IF;
END $$;

CREATE UNIQUE INDEX "bill_occurrences_setup_occurrence_key_uniq"
  ON "bill_occurrences" ("bill_setup_id", "occurrence_key");

UPDATE "forecast_events" AS event
SET "bill_occurrence_id" = occurrence."id"
FROM "bill_occurrences" AS occurrence
WHERE event."user_id" = occurrence."user_id"
  AND event."recurring_series_id" = occurrence."bill_setup_id"
  AND event."date" = occurrence."due_date"
  AND event."source_type" = 'recurring';

ALTER TABLE "forecast_events"
  ADD CONSTRAINT "forecast_events_bill_occurrence_id_bill_occurrences_id_fk"
  FOREIGN KEY ("bill_occurrence_id") REFERENCES "bill_occurrences"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "forecast_events_bill_occurrence_id_uniq"
  ON "forecast_events" ("bill_occurrence_id")
  WHERE "bill_occurrence_id" IS NOT NULL;
