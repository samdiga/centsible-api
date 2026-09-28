-- Explicit rollback only; never run automatically. Removes the reported device settings.
ALTER TABLE "notification_preferences" DROP COLUMN "push_time_zone", DROP COLUMN "push_hide_amounts";

DELETE FROM "__drizzle_migrations" WHERE hash = '89aa62adb9957c296d376f1c3af78fcd7ea3d14ee66b70e0ca0b228bb0778854';
