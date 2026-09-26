import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
  plaidItems,
  rules as rulesTable,
  transactionIdempotencyKeys,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createWithUserMutation } from "../../../src/platform/cache/user-revisions.repository.js";
import { createRulesRepository } from "../../../src/modules/rules/index.js";
import { manualTransactionRepository } from "../../../src/modules/transactions/manual-transactions.repository.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
import { createTransactionService } from "../../../src/modules/transactions/transactions.service.js";
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

guardedDescribe("POST /transactions (manual, idempotent)", () => {
  it("moves the balance exactly once per key, replays, rejects reuse and non-manual accounts, and applies rules only without a picked category", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const service = createTransactionService({
        repository: createTransactionRepository(db),
        manualRepository: manualTransactionRepository,
        rules: createRulesRepository(db),
        cache: {
          getOrCompute: (_key, compute) => compute(),
          invalidateUser: () => undefined,
        },
        withUserMutation: createWithUserMutation({
          db,
          cache: { invalidateUser: () => undefined },
        }),
      });
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const otherUserId = randomUUID();
      await db.insert(users).values({
        id: otherUserId,
        email: `${otherUserId}@example.test`,
        name: "Other",
      });
      const manualAccount = async (
        subtype: "checking" | "credit_card",
        balance: bigint,
        archivedAt: Date | null = null,
      ) =>
        (
          await db
            .insert(accounts)
            .values({
              userId,
              name: subtype,
              type: subtype === "credit_card" ? "credit" : "depository",
              subtype,
              currency: "USD",
              currentBalance: balance,
              isManual: true,
              archivedAt,
            })
            .returning()
        )[0]!;
      const checking = await manualAccount("checking", 10_000n);
      const card = await manualAccount("credit_card", 2_000n);
      const archived = await manualAccount("checking", 0n, new Date());
      const [item] = await db
        .insert(plaidItems)
        .values({
          userId,
          plaidItemId: `pi-${randomUUID()}`,
          institutionId: "ins",
          institutionName: "Bank",
          accessTokenEncrypted: "e",
          accessTokenNonce: "n",
        })
        .returning();
      const [linked] = await db
        .insert(accounts)
        .values({
          userId,
          plaidItemId: item!.id,
          plaidAccountId: `pa-${randomUUID()}`,
          name: "Linked",
          type: "depository",
          subtype: "checking",
          currency: "USD",
          currentBalance: 500n,
        })
        .returning();
      const [groceries] = await db
        .insert(categories)
        .values({ name: "Groceries", userId })
        .returning();
      const [treats] = await db
        .insert(categories)
        .values({ name: "Treats", userId })
        .returning();
      await db.insert(rulesTable).values({
        userId,
        matchType: "name_contains",
        matchNameContains: "market",
        actionCategoryId: groceries!.id,
      });

      const balanceOf = async (id: string) =>
        (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!
          .currentBalance;
      const rowsOn = async (accountId: string) =>
        db
          .select()
          .from(transactions)
          .where(eq(transactions.accountId, accountId));
      const body = {
        accountId: checking.id,
        amount: "1250",
        date: "2026-09-20",
        name: "Farmers market",
      };

      // Same key, same body, sent concurrently and then again: one effect.
      const key = randomUUID();
      const [a, b] = await Promise.all([
        service.createManualTransaction(userId, key, body),
        service.createManualTransaction(userId, key, body),
      ]);
      const again = await service.createManualTransaction(userId, key, body);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(again.replayed).toBe(true);
      expect(a.transaction).toEqual(b.transaction);
      expect(again.transaction).toEqual(a.transaction);
      expect(await rowsOn(checking.id)).toHaveLength(1);
      expect(await balanceOf(checking.id)).toBe(8_750n);

      // The rule categorised it (no category was picked); not a user choice.
      const [created] = await rowsOn(checking.id);
      expect(created!.plaidTransactionId).toBeNull();
      expect(created!.categoryId).toBe(groceries!.id);
      expect(created!.userCategoryOverride).toBe(false);
      expect(a.transaction.isManual).toBe(true);

      // Same key, different body: rejected, nothing written.
      await expect(
        service.createManualTransaction(userId, key, { ...body, amount: "1" }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
        httpStatus: 422,
      });
      expect(await balanceOf(checking.id)).toBe(8_750n);

      // A picked category wins over the matching rule.
      const picked = await service.createManualTransaction(
        userId,
        randomUUID(),
        { ...body, amount: "-300", categoryId: treats!.id },
      );
      expect(picked.transaction.categoryId).toBe(treats!.id);
      expect(picked.transaction.userCategoryOverride).toBe(true);
      expect(await balanceOf(checking.id)).toBe(9_050n);

      // Credit card: a purchase raises the amount owed; overpaying is refused
      // and rolls back the insert and the key.
      await service.createManualTransaction(userId, randomUUID(), {
        ...body,
        accountId: card.id,
        amount: "500",
      });
      expect(await balanceOf(card.id)).toBe(2_500n);
      const overpayKey = randomUUID();
      await expect(
        service.createManualTransaction(userId, overpayKey, {
          ...body,
          accountId: card.id,
          amount: "-3000",
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });
      expect(await balanceOf(card.id)).toBe(2_500n);
      expect(await rowsOn(card.id)).toHaveLength(1);
      expect(
        await db
          .select()
          .from(transactionIdempotencyKeys)
          .where(
            and(
              eq(transactionIdempotencyKeys.userId, userId),
              eq(transactionIdempotencyKeys.key, overpayKey),
            ),
          ),
      ).toHaveLength(0);

      // Linked 422, archived 409, another user's account 404.
      await expect(
        service.createManualTransaction(userId, randomUUID(), {
          ...body,
          accountId: linked!.id,
        }),
      ).rejects.toMatchObject({ httpStatus: 422 });
      expect(await balanceOf(linked!.id)).toBe(500n);
      await expect(
        service.createManualTransaction(userId, randomUUID(), {
          ...body,
          accountId: archived.id,
        }),
      ).rejects.toMatchObject({ httpStatus: 409 });
      await expect(
        service.createManualTransaction(otherUserId, randomUUID(), body),
      ).rejects.toMatchObject({ httpStatus: 404 });
      expect(await balanceOf(checking.id)).toBe(9_050n);
    } finally {
      await testDb.cleanup();
    }
  }, 180_000);
});

guardedDescribe("PATCH and DELETE manual transactions", () => {
  it("moves balances exactly when editing amount/account, and reverses once on delete", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const [checking] = await db
        .insert(accounts)
        .values({
          userId,
          name: "Checking",
          type: "depository",
          subtype: "checking",
          currency: "USD",
          currentBalance: 10_000n,
          isManual: true,
        })
        .returning();
      const [card] = await db
        .insert(accounts)
        .values({
          userId,
          name: "Card",
          type: "credit",
          subtype: "credit_card",
          currency: "USD",
          currentBalance: 500n,
          isManual: true,
        })
        .returning();
      const service = createTransactionService({
        repository: createTransactionRepository(db),
        manualRepository: manualTransactionRepository,
        rules: { listActiveRules: async () => [] },
        cache: {
          getOrCompute: (_key, compute) => compute(),
          invalidateUser: () => undefined,
        },
        withUserMutation: createWithUserMutation({
          db,
          cache: { invalidateUser: () => undefined },
        }),
      });
      const created = await service.createManualTransaction(
        userId,
        randomUUID(),
        {
          accountId: checking!.id,
          amount: "1000",
          date: "2026-09-20",
          name: "Market",
        },
      );
      expect(
        (
          await db.select().from(accounts).where(eq(accounts.id, checking!.id))
        )[0]!.currentBalance,
      ).toBe(9_000n);

      const edited = await service.patchTransaction(
        userId,
        created.transaction.id,
        { amount: 2_000n, accountId: card!.id },
      );
      expect(edited).toMatchObject({
        id: created.transaction.id,
        amount: "2000",
        accountId: card!.id,
      });
      expect(
        (
          await db.select().from(accounts).where(eq(accounts.id, checking!.id))
        )[0]!.currentBalance,
      ).toBe(10_000n);
      expect(
        (await db.select().from(accounts).where(eq(accounts.id, card!.id)))[0]!
          .currentBalance,
      ).toBe(2_500n);

      await service.deleteManualTransaction(userId, created.transaction.id);
      const deleted = (
        await db
          .select()
          .from(transactions)
          .where(eq(transactions.id, created.transaction.id))
      )[0]!;
      expect(deleted.deletedAt).not.toBeNull();
      expect(deleted.status).toBe("removed");
      expect(
        (await db.select().from(accounts).where(eq(accounts.id, card!.id)))[0]!
          .currentBalance,
      ).toBe(500n);
      await expect(
        service.deleteManualTransaction(userId, created.transaction.id),
      ).rejects.toMatchObject({ httpStatus: 404 });
      expect(
        (await db.select().from(accounts).where(eq(accounts.id, card!.id)))[0]!
          .currentBalance,
      ).toBe(500n);
    } finally {
      await testDb.cleanup();
    }
  }, 180_000);
});
