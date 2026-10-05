-- Explicit rollback only; never run automatically. Drops the user's unmatch
-- history, so auto-match may re-link pairs they rejected.
DROP TABLE "bill_match_rejections";

DELETE FROM "__drizzle_migrations" WHERE hash = 'b40816345d3a752e17d0246737dc82a6c5cfc987930adada6277793e2e9d5646';
