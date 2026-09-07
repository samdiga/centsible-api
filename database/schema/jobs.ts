import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** Database-backed work queue. */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusScheduledIdx: index("jobs_status_scheduled_idx").on(
      t.status,
      t.scheduledFor,
    ),
    userTypeIdx: index("jobs_user_type_idx").on(t.userId, t.type),
    runningLeaseExpiresIdx: index("jobs_running_lease_expires_idx")
      .on(t.leaseExpiresAt)
      .where(sql`status = 'running'`),
    oneActiveSyncPerUser: uniqueIndex("jobs_one_active_sync_per_user")
      .on(sql`(payload->>'userId')`)
      .where(sql`type = 'sync_pipeline' AND status IN ('pending', 'running')`),
  }),
);
