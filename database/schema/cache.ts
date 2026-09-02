import { sql } from "drizzle-orm";
import { bigint, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema.js";

export const userDataVersions = pgTable("user_data_versions", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  revision: bigint("revision", { mode: "bigint" })
    .notNull()
    .default(sql`1`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
