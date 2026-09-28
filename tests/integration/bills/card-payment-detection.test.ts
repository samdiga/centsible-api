import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accounts,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
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

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

guardedDescribe("card payment detection input", () => {
  it("flags only card payments that land on the user's own linked card", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const otherUserId = randomUUID();
      await testDb.db.insert(users).values(
        [userId, otherUserId].map((id) => ({
          id,
          email: `${id}@example.test`,
        })),
      );
      const [checking, card, deletedCard, otherCard] = await testDb.db
        .insert(accounts)
        .values([
          { userId, name: "Checking", type: "depository", subtype: "checking" },
          { userId, name: "Card", type: "credit", subtype: "credit_card" },
          {
            userId,
            name: "Old card",
            type: "credit",
            subtype: "credit_card",
            deletedAt: new Date(),
          },
          {
            userId: otherUserId,
            name: "Other card",
            type: "credit",
            subtype: "credit_card",
          },
        ])
        .returning();
      const payment = (name: string, amount: bigint, days: number) => ({
        userId,
        accountId: checking!.id,
        name,
        amount,
        date: daysAgo(days),
        status: "posted" as const,
        plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      });
      await testDb.db.insert(transactions).values([
        // Lands on the linked card: $0.75 off, 2 days later.
        payment("linked", 10000n, 10),
        {
          userId,
          accountId: card!.id,
          name: "Payment thank you",
          amount: -10075n,
          date: daysAgo(8),
          status: "posted",
        },
        // Only a deleted card or another user's card received it.
        payment("deleted card", 20000n, 20),
        {
          userId,
          accountId: deletedCard!.id,
          name: "Payment thank you",
          amount: -20000n,
          date: daysAgo(20),
          status: "posted",
        },
        payment("other user", 30000n, 30),
        {
          userId: otherUserId,
          accountId: otherCard!.id,
          name: "Payment thank you",
          amount: -30000n,
          date: daysAgo(30),
          status: "posted",
        },
        // More than $1 off, or more than 3 days apart.
        payment("amount off", 40000n, 40),
        {
          userId,
          accountId: card!.id,
          name: "Payment thank you",
          amount: -40101n,
          date: daysAgo(40),
          status: "posted",
        },
        payment("too late", 50000n, 50),
        {
          userId,
          accountId: card!.id,
          name: "Payment thank you",
          amount: -50000n,
          date: daysAgo(46),
          status: "posted",
        },
        payment("unlinked", 60000n, 60),
      ]);

      const rows = await createBillsRepository(
        testDb.db,
      ).detectionTransactions(userId);
      const flag = (name: string) =>
        rows.find((row) => row.name === name)?.paysLinkedCard;
      expect(flag("linked")).toBe(true);
      for (const name of [
        "deleted card",
        "other user",
        "amount off",
        "too late",
        "unlinked",
      ])
        expect(flag(name), name).toBe(false);
      // Card-side inflows are never card payments themselves.
      expect(
        rows
          .filter((row) => row.name === "Payment thank you")
          .every((row) => row.paysLinkedCard === false),
      ).toBe(true);
    } finally {
      await testDb.cleanup();
    }
  }, 30_000);
});
