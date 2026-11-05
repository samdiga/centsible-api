import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { createResponseCache } from "../../platform/cache/response-cache.js";
import type { ResponseCache } from "../../platform/cache/response-cache.js";
import type { UserMutationService } from "../../platform/cache/user-revisions.repository.js";
import { createWithUserMutation } from "../../platform/cache/user-revisions.repository.js";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db } from "../../platform/database/types.js";
import {
  cardBillName,
  refreshCardBillLabels,
  shownAccountName,
} from "../accounts/card-bill-labels.js";
import { withDerivedStatements } from "../accounts/card-statement.js";

export type StatementBillsDependencies = Readonly<{
  db?: Db;
  withUserMutation?: UserMutationService["withUserMutation"];
  cache?: Pick<ResponseCache, "invalidateUser">;
  refreshLabels?: typeof refreshCardBillLabels;
}>;

/**
 * Builds active, user-confirmed transfer bills from current credit/loan
 * statements without resurrecting user-disabled rows. A card's bill is the
 * monthly transfer bill to it, never one found by name: Plaid names cards
 * generically ("CREDIT CARD", two "Venture X"), and a shared name used to
 * leave one bill passed between the cards. Its shown name comes from the
 * account (refreshCardBillLabels); canonical_name is only a unique key.
 */
export async function upsertStatementBills(
  userId: string,
  dependencies: StatementBillsDependencies = {},
): Promise<{ created: number; updated: number }> {
  const db = dependencies.db ?? getDb();
  // A card from a Transactions-only link has no statement from the bank;
  // its statement is worked out from the user's statement and due days.
  const all = await withDerivedStatements(
    db,
    userId,
    await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
          inArray(schema.accounts.type, ["credit", "loan"]),
        ),
      ),
    new Date().toISOString().slice(0, 10),
  );
  const accounts = all.filter(
    (account) =>
      account.paymentDueDate !== null &&
      account.statementBalance !== null &&
      account.statementBalance > 0n,
  );
  if (!accounts.length) return { created: 0, updated: 0 };
  const mutate =
    dependencies.withUserMutation ??
    createWithUserMutation({
      db,
      cache: dependencies.cache ?? createResponseCache(),
    });
  return mutate(userId, async (tx) => {
    const known = await tx
      .select()
      .from(schema.billSetup)
      .where(
        and(
          eq(schema.billSetup.userId, userId),
          eq(schema.billSetup.cadence, "monthly"),
        ),
      )
      .orderBy(asc(schema.billSetup.createdAt));
    const taken = new Set(known.map((row) => row.canonicalName));
    let created = 0;
    let updated = 0;
    for (const account of accounts) {
      const mine = known.filter(
        (row) => row.billType === "transfer" && row.toAccountId === account.id,
      );
      const live = mine.find(
        (row) => !row.deletedAt && row.status === "active",
      );
      // The user deleted or paused this card's bill.
      if (!live && mine.length) continue;
      const amount =
        account.statementBalance! < 0n
          ? -account.statementBalance!
          : account.statementBalance!;
      const dueDate = account.paymentDueDate!;
      const dayOfMonth = Number(dueDate.slice(-2));
      if (live) {
        await tx
          .update(schema.billSetup)
          .set({
            avgAmount: amount,
            lastAmount: amount,
            nextExpectedDate: dueDate,
            dayOfMonth,
            updatedAt: new Date(),
          })
          .where(eq(schema.billSetup.id, live.id));
        updated += 1;
        continue;
      }
      const name = cardBillName(account, all);
      const canonicalName = [
        name,
        `${shownAccountName(account)} ••${account.mask ?? ""} payment`,
        `${shownAccountName(account)} payment ${account.id.slice(0, 8)}`,
      ].find((candidate) => !taken.has(candidate))!;
      taken.add(canonicalName);
      await tx.insert(schema.billSetup).values({
        userId,
        billType: "transfer",
        toAccountId: account.id,
        accountId: null,
        canonicalName,
        cadence: "monthly",
        avgAmount: amount,
        lastAmount: amount,
        nextExpectedDate: dueDate,
        dayOfMonth,
        status: "active",
        userConfirmed: true,
        autoDetected: false,
        confidence: 1,
      });
      created += 1;
    }
    await (dependencies.refreshLabels ?? refreshCardBillLabels)(tx, userId);
    return { created, updated };
  });
}
