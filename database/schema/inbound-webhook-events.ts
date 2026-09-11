import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    leaseToken: text("lease_token"),
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
    leaseTokenUniq: uniqueIndex("inbound_events_lease_token_uniq")
      .on(table.leaseToken)
      .where(sql`${table.leaseToken} IS NOT NULL`),
    attemptsCheck: check(
      "inbound_webhook_events_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
    leaseCheck: check(
      "inbound_webhook_events_lease_check",
      sql`(
        (${table.status} = 'processing'
          AND ${table.lockedBy} IS NOT NULL AND btrim(${table.lockedBy}) <> ''
          AND ${table.leaseExpiresAt} IS NOT NULL AND isfinite(${table.leaseExpiresAt})
          AND ${table.leaseToken} IS NOT NULL
          AND ${table.leaseToken} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        OR
        (${table.status} <> 'processing' AND ${table.lockedBy} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.leaseToken} IS NULL)
      )`,
    ),
  }),
);
