import { randomUUID } from "node:crypto";

import {
  accounts,
  categories,
  transactionCategorySplits,
  transactions,
  users,
} from "../../../database/schema/index.js";
import type { createIsolatedTestDatabase } from "../../support/test-database.js";

type Db = Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"];

/** A user with Restaurants, Coffee, Owed to me and a checking account. */
export async function seedSplitUser(db: Db) {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test` });
  const [restaurants, coffee, owed] = await db
    .insert(categories)
    .values([
      { userId, name: "Restaurants" },
      { userId, name: "Coffee" },
      { userId, name: "Owed to me" },
    ])
    .returning();
  const [checking] = await db
    .insert(accounts)
    .values({ userId, name: "Checking", type: "depository", subtype: "checking" })
    .returning();
  const insertTransaction = async (
    amount: bigint,
    options: Partial<typeof transactions.$inferInsert> = {},
  ) =>
    (
      await db
        .insert(transactions)
        .values({
          userId,
          accountId: checking!.id,
          amount,
          date: "2026-11-02",
          name: "Dinner",
          status: "posted",
          ...options,
        })
        .returning()
    )[0]!;
  const insertLines = (
    transactionId: string,
    lines: { categoryId: string | null; amount: bigint; isRemainder?: boolean }[],
  ) =>
    db.insert(transactionCategorySplits).values(
      lines.map((line, position) => ({
        userId,
        transactionId,
        categoryId: line.categoryId,
        amount: line.amount,
        position,
        isRemainder: line.isRemainder ?? false,
      })),
    );
  return {
    userId,
    restaurants: restaurants!,
    coffee: coffee!,
    owed: owed!,
    checking: checking!,
    insertTransaction,
    insertLines,
  };
}
