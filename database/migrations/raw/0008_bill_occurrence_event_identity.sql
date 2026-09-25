-- Raw 0003 creates this date index after generated migrations. Keep its
-- generic-recurring guard while moving linked bill events to occurrence ID.
DROP INDEX IF EXISTS forecast_events_series_date_uniq;
CREATE UNIQUE INDEX forecast_events_series_date_uniq
  ON forecast_events (recurring_series_id, date)
  WHERE recurring_series_id IS NOT NULL
    AND deleted_at IS NULL
    AND bill_occurrence_id IS NULL;
