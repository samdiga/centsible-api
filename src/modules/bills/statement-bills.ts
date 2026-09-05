import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { createResponseCache } from "../../platform/cache/response-cache.js";
import type { ResponseCache } from "../../platform/cache/response-cache.js";
import type { UserMutationService } from "../../platform/cache/user-revisions.repository.js";
import { createWithUserMutation } from "../../platform/cache/user-revisions.repository.js";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db } from "../../platform/database/types.js";

export type StatementBillsDependencies = Readonly<{
  db?: Db;
  withUserMutation?: UserMutationService["withUserMutation"];
  cache?: Pick<ResponseCache, "invalidateUser">;
}>;

/** Builds active, user-confirmed transfer bills from current credit/loan statements without resurrecting user-disabled rows. */
export async function upsertStatementBills(
  userId: string,
  dependencies: StatementBillsDependencies = {},
): Promise<{ created: number; updated: number }> {
  const db = dependencies.db ?? getDb();
  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId),
        isNull(schema.accounts.deletedAt),
        inArray(schema.accounts.type, ["credit", "loan"]),
        isNotNull(schema.accounts.paymentDueDate),
        isNotNull(schema.accounts.statementBalance),
        gt(schema.accounts.statementBalance, 0n),
      ),
    );
  if (!accounts.length) return { created: 0, updated: 0 };
  const mutate =
    dependencies.withUserMutation ??
    createWithUserMutation({
      db,
      cache: dependencies.cache ?? createResponseCache(),
    });
  return mutate(userId, async (tx) => {
    const names = accounts.map((account) => `${account.name} payment`);
    const known = await tx
      .select()
      .from(schema.billSetup)
      .where(
        and(
          eq(schema.billSetup.userId, userId),
          eq(schema.billSetup.cadence, "monthly"),
          inArray(schema.billSetup.canonicalName, names),
        ),
      );
    const byName = new Map(known.map((row) => [row.canonicalName, row]));
    let created = 0;
    let updated = 0;
    for (const account of accounts) {
      const name = `${account.name} payment`;
      const existing = byName.get(name);
      if (existing && (existing.deletedAt || existing.status !== "active"))
        continue;
      const amount =
        account.statementBalance! < 0n
          ? -account.statementBalance!
          : account.statementBalance!;
      const dueDate = account.paymentDueDate!;
      const dayOfMonth = Number(dueDate.slice(-2));
      await tx
        .insert(schema.billSetup)
        .values({
          userId,
          billType: "transfer",
          toAccountId: account.id,
          accountId: null,
          canonicalName: name,
          cadence: "monthly",
          avgAmount: amount,
          lastAmount: amount,
          nextExpectedDate: dueDate,
          dayOfMonth,
          status: "active",
          userConfirmed: true,
          autoDetected: false,
          confidence: 1,
        })
        .onConflictDoUpdate({
          target: [
            schema.billSetup.userId,
            schema.billSetup.canonicalName,
            schema.billSetup.cadence,
          ],
          set: {
            avgAmount: amount,
            lastAmount: amount,
            nextExpectedDate: dueDate,
            dayOfMonth,
            toAccountId: account.id,
            updatedAt: new Date(),
          },
        });
      if (existing) updated += 1;
      else created += 1;
    }
    return { created, updated };
  });
}
