import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Shared user table definition used by independently-owned schema modules. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  authProviderId: text("auth_provider_id").unique(),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  locale: text("locale").notNull().default("en-US"),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
