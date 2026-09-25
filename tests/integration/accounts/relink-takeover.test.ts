import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  plaidItems,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createPlaidAccountWriter } from "../../../src/modules/accounts/index.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

type TestDb = Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"];

async function insertItem(
  db: TestDb,
  userId: string,
  overrides: Partial<typeof plaidItems.$inferInsert> = {},
) {
  const [row] = await db
    .insert(plaidItems)
    .values({
      userId,
      plaidItemId: `plaid-${randomUUID()}`,
      institutionId: "ins_amex",
      institutionName: "American Express",
      accessTokenEncrypted: "e",
      accessTokenNonce: "n",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("item insert failed");
  return row;
}

async function insertAccount(
  db: TestDb,
  userId: string,
  itemId: string,
  plaidAccountId: string,
  overrides: Partial<typeof accounts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      plaidItemId: itemId,
      plaidAccountId,
      name: "Platinum Card",
      type: "credit",
      // What production stores for Plaid's "credit card" subtype today.
      subtype: "other",
      mask: "1001",
      currency: "USD",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("account insert failed");
  return row;
}

async function insertTxn(
  db: TestDb,
  userId: string,
  accountId: string,
  plaidAccountId: string | null,
  fields: {
    id: string;
    date: string;
    amount: bigint;
    name: string;
    notes?: string;
  },
) {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      plaidTransactionId: fields.id,
      amount: fields.amount,
      currency: "USD",
      date: fields.date,
      name: fields.name,
      status: "posted",
      notes: fields.notes ?? null,
      plaidRawPayload: plaidAccountId ? { account_id: plaidAccountId } : null,
    })
    .returning();
  if (!row) throw new Error("transaction insert failed");
  return row;
}

const plaidAccount = (accountId: string, mask = "1001") => ({
  account_id: accountId,
  name: "Platinum Card®",
  type: "credit",
  subtype: "credit card",
  mask,
  balances: { current: 120.5, available: null, limit: null },
});

const plaidTxn = (id: string, date: string, dollars: number, name: string) => ({
  transaction_id: id,
  amount: dollars,
  date,
  pending: false,
  name,
});

guardedDescribe("relink takeover", () => {
  it("revives the removed account and adopts its history instead of duplicating it", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const oldItem = await insertItem(db, userId, { deletedAt: new Date() });
      const oldAccount = await insertAccount(db, userId, oldItem.id, "old-pa", {
        deletedAt: new Date(),
        color: "#123456",
      });
      await insertTxn(db, userId, oldAccount.id, "old-pa", {
        id: "old-t1",
        date: "2026-09-01",
        amount: 1250n,
        name: "Coffee",
        notes: "keep me",
      });
      await insertTxn(db, userId, oldAccount.id, "old-pa", {
        id: "old-t2",
        date: "2026-09-01",
        amount: 1250n,
        name: "Coffee",
      });
      await insertTxn(db, userId, oldAccount.id, null, {
        id: "old-t3",
        date: "2026-09-02",
        amount: 500n,
        name: "Parking",
      });
      const newItem = await insertItem(db, userId);

      const revived = await createPlaidAccountWriter(db).upsertFromPlaid({
        userId,
        plaidItemUuid: newItem.id,
        account: plaidAccount("new-pa"),
      });
      expect(revived.id).toBe(oldAccount.id);
      const [accountRow] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, oldAccount.id));
      expect(accountRow).toMatchObject({
        plaidItemId: newItem.id,
        plaidAccountId: "new-pa",
        deletedAt: null,
        color: "#123456",
      });

      await createTransactionRepository(db).upsertManyFromPlaid([
        {
          userId,
          accountId: oldAccount.id,
          txn: plaidTxn("new-t1", "2026-09-01", 12.5, "Coffee"),
        },
        {
          userId,
          accountId: oldAccount.id,
          txn: plaidTxn("new-t2", "2026-09-01", 12.5, "Coffee"),
        },
        {
          userId,
          accountId: oldAccount.id,
          txn: plaidTxn("new-t3", "2026-09-02", 5, "Parking"),
        },
        {
          userId,
          accountId: oldAccount.id,
          txn: plaidTxn("new-t4", "2026-09-03", 9, "Lunch"),
        },
      ]);

      const live = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, oldAccount.id),
            isNull(transactions.deletedAt),
          ),
        );
      const byPlaidId = new Map(
        live.map((row) => [row.plaidTransactionId, row]),
      );
      // Both coffees adopted old rows (one each), keeping the user's note.
      expect(
        byPlaidId.get("new-t1")?.notes ?? byPlaidId.get("new-t2")?.notes,
      ).toBe("keep me");
      expect(byPlaidId.has("old-t1") || byPlaidId.has("old-t2")).toBe(false);
      // A row with no stored payload is never adopted, so parking duplicates
      // rather than risking a wrong match.
      expect(byPlaidId.has("old-t3")).toBe(true);
      expect(byPlaidId.has("new-t3")).toBe(true);
      // A genuinely new transaction is still inserted.
      expect(byPlaidId.has("new-t4")).toBe(true);
      expect(live).toHaveLength(5);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("never adopts rows on an account whose history came from its current link", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const item = await insertItem(db, userId);
      const account = await insertAccount(db, userId, item.id, "pa");
      await insertTxn(db, userId, account.id, "pa", {
        id: "coffee-1",
        date: "2026-09-01",
        amount: 1250n,
        name: "Coffee",
      });

      await createTransactionRepository(db).upsertManyFromPlaid([
        {
          userId,
          accountId: account.id,
          txn: plaidTxn("coffee-2", "2026-09-01", 12.5, "Coffee"),
        },
      ]);

      const ids = (
        await db
          .select()
          .from(transactions)
          .where(eq(transactions.accountId, account.id))
      ).map((row) => row.plaidTransactionId);
      expect(ids.sort()).toEqual(["coffee-1", "coffee-2"]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("creates a new account when the removed candidates are ambiguous or differ", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const oldA = await insertItem(db, userId, { deletedAt: new Date() });
      const oldB = await insertItem(db, userId, { deletedAt: new Date() });
      await insertAccount(db, userId, oldA.id, "a-pa", {
        deletedAt: new Date(),
      });
      await insertAccount(db, userId, oldB.id, "b-pa", {
        deletedAt: new Date(),
      });
      const other = await insertItem(db, userId, {
        institutionId: "ins_chase",
        deletedAt: new Date(),
      });
      await insertAccount(db, userId, other.id, "c-pa", {
        deletedAt: new Date(),
        mask: "2002",
      });
      const newItem = await insertItem(db, userId);
      const writer = createPlaidAccountWriter(db);

      const ambiguous = await writer.upsertFromPlaid({
        userId,
        plaidItemUuid: newItem.id,
        account: plaidAccount("new-1"),
      });
      // Same mask as a removed Chase account, but a different institution.
      const otherBank = await writer.upsertFromPlaid({
        userId,
        plaidItemUuid: newItem.id,
        account: plaidAccount("new-2", "2002"),
      });

      const revivedCount = (
        await db
          .select()
          .from(accounts)
          .where(and(eq(accounts.userId, userId), isNull(accounts.deletedAt)))
      ).length;
      expect(revivedCount).toBe(2);
      expect([ambiguous.plaidAccountId, otherBank.plaidAccountId]).toEqual([
        "new-1",
        "new-2",
      ]);
      expect(ambiguous.createdAt.getTime()).toBeGreaterThanOrEqual(
        newItem.createdAt.getTime(),
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
