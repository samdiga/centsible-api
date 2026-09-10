import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Verified provider deliveries retained for asynchronous worker processing. */
export const inboundWebhookEvents = pgTable(
  "inbound_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    webhookType: text("webhook_type").notNull(),
    webhookCode: text("webhook_code").notNull(),
    providerItemId: text("provider_item_id"),
    payload: jsonb("payload").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastErrorCode: text("last_error_code"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    statusAvailableIdx: index("inbound_events_status_available_idx").on(
      table.status,
      table.availableAt,
    ),
    leaseExpiresIdx: index("inbound_events_lease_expires_idx").on(
      table.leaseExpiresAt,
    ),
    providerItemIdx: index("inbound_events_provider_item_idx").on(
      table.providerItemId,
    ),
    dedupeIdx: index("inbound_events_dedupe_idx").on(table.dedupeKey),
  }),
);
