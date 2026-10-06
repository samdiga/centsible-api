-- Explicit rollback only; never run automatically. The user's copies stay as
-- ordinary custom categories, but the defaults they replaced reappear beside
-- them (shown twice by name) until the copies are archived.
DROP TABLE "category_overrides";

DELETE FROM "__drizzle_migrations" WHERE hash = '968021f431573439b22bde8dc73e2910a3a1e8c44d5c2c236bc0de8800e4d075';
