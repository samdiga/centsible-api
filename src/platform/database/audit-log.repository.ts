import { lt, sql } from "drizzle-orm";

import { schema, getDb } from "./client.js";
import type { Db, DbTransaction } from "./types.js";
import { ValidationError } from "../errors/app-error.js";

export type AuditAction = (typeof schema.auditActionEnum.enumValues)[number];
export type AuditLogDb = Db | DbTransaction;
export type AuditLogEntry = Readonly<{
  userId: string;
  entityType: string;
  entityId: string;
  action: AuditAction;
  source: string;
  before?: unknown;
  after?: unknown;
  requestId?: string | undefined;
}>;

export type AuditLogRepository = Readonly<{
  record: (entry: AuditLogEntry, db?: AuditLogDb) => Promise<void>;
  purgeOlderThanDays: (days: number, db?: AuditLogDb) => Promise<number>;
}>;

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonValue(child)]),
    );
  }
  return value;
}

export const auditLogRepository: AuditLogRepository = {
  async record(entry, db = getDb()) {
    await db.insert(schema.auditLog).values({
      userId: entry.userId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      source: entry.source,
      beforeJson: jsonValue(entry.before),
      afterJson: jsonValue(entry.after),
      requestId: entry.requestId ?? null,
    });
  },

  async purgeOlderThanDays(days, db = getDb()) {
    if (!Number.isSafeInteger(days) || days <= 0) {
      throw new ValidationError("Retention days must be a positive integer.");
    }
    const rows = await db
      .delete(schema.auditLog)
      .where(
        lt(
          schema.auditLog.createdAt,
          sql`now() - (${days} || ' days')::interval`,
        ),
      )
      .returning({ id: schema.auditLog.id });
    return rows.length;
  },
};

export function createAuditLogRepository(db: Db): AuditLogRepository {
  return {
    record: (entry, transaction) =>
      auditLogRepository.record(entry, transaction ?? db),
    purgeOlderThanDays: (days, transaction) =>
      auditLogRepository.purgeOlderThanDays(days, transaction ?? db),
  };
}

export const auditRepository = auditLogRepository;
