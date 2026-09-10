import { sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db } from "../../platform/database/types.js";
import {
  normalizeErrorCode,
  MAX_CLAIM_LIMIT,
} from "../../platform/jobs/jobs.types.js";
import type {
  ClaimedInboundWebhookEvent,
  InboundWebhookEvent,
  InboundWebhookEventInput,
} from "./inbound-events.types.js";

export const INBOUND_EVENT_LEASE_MS = 5 * 60_000;
export const INBOUND_EVENT_MAX_ATTEMPTS = 8;

type RawInboundEvent = Omit<InboundWebhookEvent, "status"> & { status: string };
export type InboundEventsRepository = Readonly<{
  insert: (
    input: InboundWebhookEventInput,
    db?: Db,
  ) => Promise<InboundWebhookEvent>;
  claimInboundEvents: (
    workerId: string,
    limit: number,
    leaseMs?: number,
  ) => Promise<ClaimedInboundWebhookEvent[]>;
  markProcessed: (id: string, workerId: string) => Promise<boolean>;
  scheduleRetry: (
    id: string,
    workerId: string,
    attempt: number,
    errorCode: string,
    now?: Date,
    random?: () => number,
  ) => Promise<boolean>;
  markDead: (id: string, workerId: string, code: string) => Promise<boolean>;
  hasProcessedDuplicate: (id: string, dedupeKey: string) => Promise<boolean>;
  findById: (id: string) => Promise<InboundWebhookEvent | null>;
  replayDeadEvent: (id: string) => Promise<InboundWebhookEvent | null>;
}>;

function toEvent(row: RawInboundEvent): InboundWebhookEvent {
  if (
    !(["pending", "processing", "processed", "dead"] as string[]).includes(
      row.status,
    )
  ) {
    throw new Error("Database returned an invalid inbound event status");
  }
  return { ...row, status: row.status as InboundWebhookEvent["status"] };
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0)
    throw new RangeError("limit must be a positive integer");
  return Math.min(limit, MAX_CLAIM_LIMIT);
}

function validateLeaseMs(leaseMs: number): number {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0)
    throw new RangeError("leaseMs must be a positive integer");
  return leaseMs;
}

function validateAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt <= 0)
    throw new RangeError("attempt must be a positive integer");
}

/** Retry delay is 30s exponential, capped before 0-25% jitter at one hour. */
export function nextRetryAt(
  attempt: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date {
  validateAttempt(attempt);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new RangeError("random source must return a number between 0 and 1");
  }
  const base = Math.min(30_000 * 2 ** (attempt - 1), 60 * 60_000);
  return new Date(now.getTime() + Math.floor(base * (1 + 0.25 * sample)));
}

export function createInboundEventsRepository(
  db: Db = getDb(),
): InboundEventsRepository {
  return {
    async insert(input, database = db) {
      const rows = await database
        .insert(schema.inboundWebhookEvents)
        .values({
          ...(input.id ? { id: input.id } : {}),
          provider: input.provider,
          webhookType: input.webhookType,
          webhookCode: input.webhookCode,
          providerItemId: input.providerItemId ?? null,
          payload: input.payload,
          payloadDigest: input.payloadDigest,
          dedupeKey: input.dedupeKey,
          receivedAt: input.receivedAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Inbound webhook event insert returned no row");
      return toEvent(row as unknown as RawInboundEvent);
    },

    async claimInboundEvents(
      workerId,
      limit,
      leaseMs = INBOUND_EVENT_LEASE_MS,
    ) {
      if (!workerId.trim()) throw new RangeError("workerId is required");
      const boundedLimit = validateLimit(limit);
      const boundedLease = validateLeaseMs(leaseMs);
      const rows = await db.execute<RawInboundEvent>(sql`
        WITH candidates AS (
          SELECT id
          FROM inbound_webhook_events
          WHERE (
            (status = 'pending' AND available_at <= now())
            OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
          )
          AND attempts < ${INBOUND_EVENT_MAX_ATTEMPTS}
          ORDER BY available_at ASC, id ASC
          LIMIT ${boundedLimit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE inbound_webhook_events AS event
        SET status = 'processing',
            attempts = event.attempts + 1,
            locked_by = ${workerId},
            lease_expires_at = now() + (${boundedLease} * interval '1 millisecond'),
            processed_at = NULL
        FROM candidates
        WHERE event.id = candidates.id
        RETURNING
          event.id,
          event.provider,
          event.webhook_type AS "webhookType",
          event.webhook_code AS "webhookCode",
          event.provider_item_id AS "providerItemId",
          event.payload,
          event.payload_digest AS "payloadDigest",
          event.dedupe_key AS "dedupeKey",
          event.status,
          event.attempts,
          event.available_at AS "availableAt",
          event.lease_expires_at AS "leaseExpiresAt",
          event.locked_by AS "lockedBy",
          event.last_error_code AS "lastErrorCode",
          event.received_at AS "receivedAt",
          event.processed_at AS "processedAt"
      `);
      return rows
        .map(toEvent)
        .filter(
          (row): row is ClaimedInboundWebhookEvent =>
            row.status === "processing" &&
            row.lockedBy === workerId &&
            row.leaseExpiresAt !== null,
        );
    },

    async markProcessed(id, workerId) {
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE inbound_webhook_events
        SET status = 'processed', processed_at = now(),
            locked_by = NULL, lease_expires_at = NULL, last_error_code = NULL
        WHERE id = ${id} AND status = 'processing' AND locked_by = ${workerId}
        RETURNING id
      `);
      return rows.some((row) => row.id === id);
    },

    async scheduleRetry(
      id,
      workerId,
      attempt,
      errorCode,
      now = new Date(),
      random = Math.random,
    ) {
      validateAttempt(attempt);
      const availableAt = nextRetryAt(attempt, now, random);
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE inbound_webhook_events
        SET status = 'pending', available_at = ${availableAt.toISOString()}::timestamptz,
            locked_by = NULL, lease_expires_at = NULL,
            last_error_code = ${normalizeErrorCode(errorCode)}
        WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}
          AND locked_by = ${workerId}
        RETURNING id
      `);
      return rows.some((row) => row.id === id);
    },

    async markDead(id, workerId, code) {
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE inbound_webhook_events
        SET status = 'dead', processed_at = now(),
            locked_by = NULL, lease_expires_at = NULL,
            last_error_code = ${normalizeErrorCode(code)}
        WHERE id = ${id} AND status = 'processing' AND locked_by = ${workerId}
        RETURNING id
      `);
      return rows.some((row) => row.id === id);
    },

    async hasProcessedDuplicate(id, dedupeKey) {
      const rows = await db.execute<{ id: string }>(sql`
        SELECT id
        FROM inbound_webhook_events
        WHERE dedupe_key = ${dedupeKey}
          AND status = 'processed'
          AND id <> ${id}
        LIMIT 1
      `);
      return rows.length > 0;
    },

    async findById(id) {
      const rows = await db.execute<RawInboundEvent>(sql`
        SELECT
          id, provider, webhook_type AS "webhookType",
          webhook_code AS "webhookCode", provider_item_id AS "providerItemId",
          payload, payload_digest AS "payloadDigest", dedupe_key AS "dedupeKey",
          status, attempts, available_at AS "availableAt",
          lease_expires_at AS "leaseExpiresAt", locked_by AS "lockedBy",
          last_error_code AS "lastErrorCode", received_at AS "receivedAt",
          processed_at AS "processedAt"
        FROM inbound_webhook_events
        WHERE id = ${id}
        LIMIT 1
      `);
      return rows[0] ? toEvent(rows[0]) : null;
    },

    async replayDeadEvent(id) {
      const rows = await db.execute<RawInboundEvent>(sql`
        UPDATE inbound_webhook_events
        SET status = 'pending', attempts = 0, available_at = now(),
            locked_by = NULL, lease_expires_at = NULL,
            last_error_code = NULL, processed_at = NULL
        WHERE id = ${id} AND status = 'dead'
        RETURNING
          id, provider, webhook_type AS "webhookType",
          webhook_code AS "webhookCode", provider_item_id AS "providerItemId",
          payload, payload_digest AS "payloadDigest", dedupe_key AS "dedupeKey",
          status, attempts, available_at AS "availableAt",
          lease_expires_at AS "leaseExpiresAt", locked_by AS "lockedBy",
          last_error_code AS "lastErrorCode", received_at AS "receivedAt",
          processed_at AS "processedAt"
      `);
      return rows[0] ? toEvent(rows[0]) : null;
    },
  };
}
