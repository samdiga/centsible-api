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
  markProcessed: (
    id: string,
    workerId: string,
    attempt: number,
    leaseToken: string,
  ) => Promise<boolean>;
  scheduleRetry: (
    id: string,
    workerId: string,
    attempt: number,
    leaseToken: string,
    errorCode: string,
    now?: Date,
    random?: () => number,
  ) => Promise<boolean>;
  markDead: (
    id: string,
    workerId: string,
    attempt: number,
    leaseToken: string,
    code: string,
  ) => Promise<boolean>;
  heartbeatInboundEvent: (
    id: string,
    workerId: string,
    attempt: number,
    leaseToken: string,
    leaseMs?: number,
  ) => Promise<boolean>;
  releaseInboundEvent: (
    id: string,
    workerId: string,
    attempt: number,
    leaseToken: string,
  ) => Promise<boolean>;
  hasProcessedDuplicate: (id: string, dedupeKey: string) => Promise<boolean>;
  findById: (id: string) => Promise<InboundWebhookEvent | null>;
  replayDeadEvent: (id: string) => Promise<InboundWebhookEvent | null>;
  nextAvailableAt: () => Promise<Date | null>;
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
        WITH expired_candidates AS (
          SELECT id, status
          FROM inbound_webhook_events
          WHERE attempts >= ${INBOUND_EVENT_MAX_ATTEMPTS}
            AND (
              status = 'pending'
              OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
          )
          ORDER BY available_at ASC, id ASC
          LIMIT ${MAX_CLAIM_LIMIT}
          FOR UPDATE SKIP LOCKED
        ), expired_dead AS (
          UPDATE inbound_webhook_events AS exhausted
          SET status = 'dead', processed_at = now(),
              locked_by = NULL, lease_expires_at = NULL,
              lease_token = NULL,
              last_error_code = CASE
                WHEN expired.status = 'processing' THEN 'LEASE_EXPIRED'
                ELSE 'ATTEMPTS_EXHAUSTED'
              END
          FROM expired_candidates AS expired
          WHERE exhausted.id = expired.id
          RETURNING exhausted.id
        ), candidates AS (
          SELECT candidate.id
          FROM inbound_webhook_events AS candidate
          WHERE (
            (candidate.status = 'pending' AND candidate.available_at <= now())
            OR (candidate.status = 'processing' AND candidate.lease_expires_at IS NOT NULL AND candidate.lease_expires_at <= now())
          )
          AND candidate.attempts < ${INBOUND_EVENT_MAX_ATTEMPTS}
          AND (
            candidate.provider_item_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM inbound_webhook_events AS earlier
              WHERE earlier.provider = candidate.provider
                AND earlier.provider_item_id = candidate.provider_item_id
                AND earlier.status IN ('pending', 'processing')
                AND (earlier.received_at, earlier.id) < (candidate.received_at, candidate.id)
            )
          )
          ORDER BY candidate.available_at ASC, candidate.id ASC
          LIMIT ${boundedLimit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE inbound_webhook_events AS event
        SET status = 'processing',
            attempts = event.attempts + 1,
            locked_by = ${workerId},
            lease_token = gen_random_uuid()::text,
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
          event.lease_token AS "leaseToken",
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
            typeof row.leaseToken === "string" &&
            row.leaseExpiresAt !== null,
        );
    },

    async markProcessed(id, workerId, attempt, leaseToken) {
      validateAttempt(attempt);
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE inbound_webhook_events
        SET status = 'processed', processed_at = now(),
            locked_by = NULL, lease_expires_at = NULL, lease_token = NULL,
            last_error_code = NULL
        WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}
          AND locked_by = ${workerId} AND lease_token = ${leaseToken}
        RETURNING id
      `);
      return rows.some((row) => row.id === id);
    },

    async scheduleRetry(
      id,
      workerId,
      attempt,
      leaseToken,
      errorCode,
      now = new Date(),
      random = Math.random,
    ) {
      validateAttempt(attempt);
      const availableAt = nextRetryAt(attempt, now, random);
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE inbound_webhook_events
        SET status = 'pending', available_at = ${availableAt.toISOString()}::timestamptz,
            locked_by = NULL, lease_expires_at = NULL, lease_token = NULL,
            last_error_code = ${normalizeErrorCode(errorCode)}
        WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}
          AND locked_by = ${workerId} AND lease_token = ${leaseToken}
        RETURNING id
      `);
      return rows.some((row) => row.id === id);
    },

    async markDead(id, workerId, attempt, leaseToken, code) {
      validateAttempt(attempt);
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE inbound_webhook_events
        SET status = 'dead', processed_at = now(),
            locked_by = NULL, lease_expires_at = NULL, lease_token = NULL,
            last_error_code = ${normalizeErrorCode(code)}
        WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}
          AND locked_by = ${workerId} AND lease_token = ${leaseToken}
        RETURNING id
      `);
      return rows.some((row) => row.id === id);
    },

    async heartbeatInboundEvent(
      id,
      workerId,
      attempt,
      leaseToken,
      leaseMs = INBOUND_EVENT_LEASE_MS,
    ) {
      validateAttempt(attempt);
      const boundedLease = validateLeaseMs(leaseMs);
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE inbound_webhook_events
        SET lease_expires_at = now() + (${boundedLease} * interval '1 millisecond')
        WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}
          AND locked_by = ${workerId} AND lease_token = ${leaseToken}
        RETURNING id
      `);
      return rows.some((row) => row.id === id);
    },

    async releaseInboundEvent(id, workerId, attempt, leaseToken) {
      validateAttempt(attempt);
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE inbound_webhook_events
        SET status = 'pending',
            attempts = GREATEST(attempts - 1, 0),
            available_at = now(),
            locked_by = NULL,
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error_code = NULL,
            processed_at = NULL
        WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}
          AND locked_by = ${workerId} AND lease_token = ${leaseToken}
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
          lease_token AS "leaseToken",
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
            lease_token = NULL,
            last_error_code = NULL, processed_at = NULL
        WHERE id = ${id} AND status = 'dead'
        RETURNING
          id, provider, webhook_type AS "webhookType",
          webhook_code AS "webhookCode", provider_item_id AS "providerItemId",
          payload, payload_digest AS "payloadDigest", dedupe_key AS "dedupeKey",
          status, attempts, available_at AS "availableAt",
          lease_expires_at AS "leaseExpiresAt", locked_by AS "lockedBy",
          lease_token AS "leaseToken",
          last_error_code AS "lastErrorCode", received_at AS "receivedAt",
          processed_at AS "processedAt"
      `);
      return rows[0] ? toEvent(rows[0]) : null;
    },

    async nextAvailableAt() {
      const rows = await db.execute<{ availableAt: Date | null }>(sql`
        SELECT min(available_at) AS "availableAt"
        FROM inbound_webhook_events
        WHERE status = 'pending' AND available_at > now()
      `);
      return rows[0]?.availableAt ?? null;
    },
  };
}
