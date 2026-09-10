import { randomUUID } from "node:crypto";
import { schema } from "../../src/platform/database/client.js";
import type { Db } from "../../src/platform/database/types.js";

/**
 * The persisted Centsy output boundary. Keep this independent from the API
 * input DTO: Centsy inserts this exact database row and does not use RETURNING.
 */
export type CentsyWebhookEvent = Readonly<{
  id: string;
  provider: "plaid";
  webhookType: string;
  webhookCode: string;
  providerItemId?: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  dedupeKey: string;
  status: "pending";
  attempts: 0;
  availableAt: Date;
}>;

const fixtureTimestamp = new Date("2026-09-10T12:00:00.000Z");

export function centsyWebhookEvent(
  overrides: Partial<CentsyWebhookEvent> = {},
): CentsyWebhookEvent {
  return {
    id: randomUUID(),
    provider: "plaid",
    webhookType: "TRANSACTIONS",
    webhookCode: "SYNC_UPDATES_AVAILABLE",
    providerItemId: "item-centsy-contract",
    payload: {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-centsy-contract",
      new_transactions: 2,
    },
    payloadDigest: "a".repeat(64),
    dedupeKey: "b".repeat(64),
    status: "pending",
    attempts: 0,
    availableAt: fixtureTimestamp,
    ...overrides,
  };
}

export const validSyncWebhook = centsyWebhookEvent();

export const validItemErrorWebhook = centsyWebhookEvent({
  webhookType: "ITEM",
  webhookCode: "ERROR",
  payload: {
    webhook_type: "ITEM",
    webhook_code: "ERROR",
    item_id: "item-centsy-contract",
    error: {
      error_code: "ITEM_LOGIN_REQUIRED",
      error_message: "Reauthenticate this item",
    },
  },
  payloadDigest: "c".repeat(64),
  dedupeKey: "d".repeat(64),
});

/** Mirrors Centsy's one-way insert: UUID is known before insertion, no RETURNING. */
export async function insertFixtureFromCentsy(
  db: Db,
  event: CentsyWebhookEvent,
): Promise<{ id: string }> {
  await db.insert(schema.inboundWebhookEvents).values(event);
  return { id: event.id };
}
