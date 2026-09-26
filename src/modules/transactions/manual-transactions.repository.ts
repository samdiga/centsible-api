import { and, eq, isNull, sql } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import type { TransactionRow } from "./transactions.repository.js";

export type ManualAccountForWrite = Readonly<{
  id: string;
  subtype: string;
  currency: string;
  isManual: boolean;
  archivedAt: Date | null;
}>;

export type StoredIdempotencyKey = Readonly<{
  requestHash: string;
  response: unknown;
}>;

export type ManualTransactionInsert = Readonly<{
  userId: string;
  accountId: string;
  amount: bigint;
  currency: string;
  date: string;
  name: string;
  merchantName: string | null;
  categoryId: string | null;
}>;

/**
 * Writes behind POST /transactions. Every method takes the caller's DB
 * transaction: the key claim, insert, balance change and stored response
 * must commit or roll back together.
 */
export type ManualTransactionRepository = Readonly<{
  /** Inserts the key; false when it already exists (waits for an in-flight claim to finish). */
  claimIdempotencyKey: (
    userId: string,
    key: string,
    requestHash: string,
    tx: DbTransaction,
  ) => Promise<boolean>;
  findIdempotencyKey: (
    userId: string,
    key: string,
    tx: DbTransaction,
  ) => Promise<StoredIdempotencyKey | null>;
  completeIdempotencyKey: (
    userId: string,
    key: string,
    transactionId: string,
    response: unknown,
    tx: DbTransaction,
  ) => Promise<void>;
  /** Locks the user's live account row for the rest of the transaction. */
  findAccountForWrite: (
    userId: string,
    accountId: string,
    tx: DbTransaction,
  ) => Promise<ManualAccountForWrite | null>;
  insertManualTransaction: (
    values: ManualTransactionInsert,
    tx: DbTransaction,
  ) => Promise<TransactionRow>;
  /** Adds `deltaCents` to the stored balance (null counts as 0); returns the new balance. */
  adjustAccountBalance: (
    userId: string,
    accountId: string,
    deltaCents: bigint,
    tx: DbTransaction,
  ) => Promise<bigint>;
}>;

export const manualTransactionRepository: ManualTransactionRepository = {
  async claimIdempotencyKey(userId, key, requestHash, tx) {
    const inserted = await tx
      .insert(schema.transactionIdempotencyKeys)
      .values({ userId, key, requestHash })
      .onConflictDoNothing()
      .returning({ key: schema.transactionIdempotencyKeys.key });
    return inserted.length === 1;
  },
  async findIdempotencyKey(userId, key, tx) {
    const [row] = await tx
      .select({
        requestHash: schema.transactionIdempotencyKeys.requestHash,
        response: schema.transactionIdempotencyKeys.response,
      })
      .from(schema.transactionIdempotencyKeys)
      .where(
        and(
          eq(schema.transactionIdempotencyKeys.userId, userId),
          eq(schema.transactionIdempotencyKeys.key, key),
        ),
      )
      .limit(1);
    return row ?? null;
  },
  async completeIdempotencyKey(userId, key, transactionId, response, tx) {
    await tx
      .update(schema.transactionIdempotencyKeys)
      .set({ transactionId, response })
      .where(
        and(
          eq(schema.transactionIdempotencyKeys.userId, userId),
          eq(schema.transactionIdempotencyKeys.key, key),
        ),
      );
  },
  async findAccountForWrite(userId, accountId, tx) {
    const [row] = await tx
      .select({
        id: schema.accounts.id,
        subtype: schema.accounts.subtype,
        currency: schema.accounts.currency,
        isManual: schema.accounts.isManual,
        archivedAt: schema.accounts.archivedAt,
      })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, accountId),
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    return row ?? null;
  },
  async insertManualTransaction(values, tx) {
    const [row] = await tx
      .insert(schema.transactions)
      .values({
        ...values,
        status: "posted",
        userCategoryOverride: values.categoryId !== null,
      })
      .returning();
    return row!;
  },
  async adjustAccountBalance(userId, accountId, deltaCents, tx) {
    const [row] = await tx
      .update(schema.accounts)
      .set({
        currentBalance: sql`coalesce(${schema.accounts.currentBalance}, 0) + ${deltaCents.toString()}::bigint`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.accounts.id, accountId),
          eq(schema.accounts.userId, userId),
        ),
      )
      .returning({ currentBalance: schema.accounts.currentBalance });
    return row?.currentBalance ?? 0n;
  },
};
