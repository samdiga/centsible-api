SET lock_timeout = '5s';

-- Keep the oldest duplicate system category rows before adding unique indexes.
WITH duplicates AS (
  SELECT
    c.id AS duplicate_id,
    keep.id AS keep_id
  FROM categories c
  JOIN categories keep
    ON c.user_id IS NULL
   AND keep.user_id IS NULL
   AND c.name = keep.name
   AND c.parent_id IS NOT DISTINCT FROM keep.parent_id
   AND c.created_at > keep.created_at
)
UPDATE transactions t
SET category_id = d.keep_id
FROM duplicates d
WHERE t.category_id = d.duplicate_id;

WITH duplicates AS (
  SELECT
    c.id AS duplicate_id,
    keep.id AS keep_id
  FROM categories c
  JOIN categories keep
    ON c.user_id IS NULL
   AND keep.user_id IS NULL
   AND c.name = keep.name
   AND c.parent_id IS NOT DISTINCT FROM keep.parent_id
   AND c.created_at > keep.created_at
)
UPDATE rules r
SET action_category_id = d.keep_id
FROM duplicates d
WHERE r.action_category_id = d.duplicate_id;

DELETE FROM categories c USING categories keep
WHERE c.user_id IS NULL AND keep.user_id IS NULL
  AND c.name = keep.name
  AND c.parent_id IS NOT DISTINCT FROM keep.parent_id
  AND c.created_at > keep.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS categories_system_root_name_uniq
  ON categories (name) WHERE user_id IS NULL AND parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS categories_system_sub_name_uniq
  ON categories (parent_id, name) WHERE user_id IS NULL AND parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_uniq
  ON categories (user_id, parent_id, name) WHERE user_id IS NOT NULL;

-- Keep the newest active budget per user before enforcing one active budget.
UPDATE budgets
SET is_active = false
WHERE is_active = true
  AND id NOT IN (
    SELECT DISTINCT ON (user_id) id
    FROM budgets
    WHERE is_active = true
    ORDER BY user_id, created_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS budgets_one_active_per_user_uniq
  ON budgets (user_id) WHERE is_active = true;

-- Keep the oldest bill setup per identity.
DELETE FROM bill_setup b USING bill_setup keep
WHERE b.user_id = keep.user_id
  AND b.canonical_name = keep.canonical_name
  AND b.cadence = keep.cadence
  AND b.created_at > keep.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS bill_setup_user_name_cadence_uniq
  ON bill_setup (user_id, canonical_name, cadence);

-- Keep the oldest forecast event per recurring identity.
DELETE FROM forecast_events f USING forecast_events keep
WHERE f.user_id = keep.user_id
  AND f.recurring_series_id = keep.recurring_series_id
  AND f.date = keep.date
  AND f.created_at > keep.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS forecast_events_identity_uniq
  ON forecast_events (user_id, recurring_series_id, date);
