import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  accounts,
  auditLog,
  billSetup,
  transactions,
  users,
} from "../../../database/schema/index.js";
import {
  inferPaidFromInMutation,
  previewPaidFrom,
} from "../../../src/modules/bills/paid-from-inference.js";
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
guardedDescribe("paid-from inference", () => {
  it("infers majority and card matches, preserves choices/external routes, ignores ties and other tenants, and audits once", async () => {
    const fixture = await createIsolatedTestDatabase();
    try {
      const { db } = fixture;
      const userId = randomUUID(),
        other = randomUUID();
      await db.insert(users).values(
        [userId, other].map((id) => ({
          id,
          email: `${id}@example.test`,
          name: "Fixture",
        })),
      );
      const cash = randomUUID(),
        cash2 = randomUUID(),
        card = randomUUID(),
        foreign = randomUUID();
      await db.insert(accounts).values([
        {
          id: cash,
          userId,
          name: "Cash",
          type: "depository",
          subtype: "checking",
        },
        {
          id: cash2,
          userId,
          name: "Cash two",
          type: "depository",
          subtype: "checking",
        },
        {
          id: card,
          userId,
          name: "Card",
          type: "credit",
          subtype: "credit_card",
        },
        {
          id: foreign,
          userId: other,
          name: "Foreign",
          type: "depository",
          subtype: "checking",
        },
      ]);
      const majority = randomUUID(),
        tie = randomUUID(),
        chosen = randomUUID(),
        external = randomUUID(),
        transfer = randomUUID();
      await db.insert(billSetup).values(
        [
          { id: majority, canonicalName: "merchant", accountId: null },
          { id: tie, canonicalName: "tie", accountId: null },
          { id: chosen, canonicalName: "chosen merchant", accountId: cash2 },
          {
            id: external,
            canonicalName: "external merchant",
            accountId: null,
            paidFromExternal: true,
          },
          {
            id: transfer,
            canonicalName: "card payment",
            accountId: null,
            billType: "transfer" as const,
            toAccountId: card,
          },
        ].map((row) => ({
          ...row,
          userId,
          cadence: "monthly" as const,
          avgAmount: 1000n,
          status: "active" as const,
        })),
      );
      const payment = (
        accountId: string,
        name: string,
        date: string,
        amount: bigint,
        extra = {},
      ) => ({ userId, accountId, name, date, amount, ...extra });
      await db.insert(transactions).values([
        payment(cash, "merchant", "2026-08-01", 1000n),
        payment(cash, "merchant", "2026-09-01", 1100n),
        payment(cash2, "merchant", "2026-07-01", 1000n),
        payment(cash2, "merchant", "2026-01-01", 1000n), // outside 180 days
        payment(cash2, "merchant", "2026-09-02", 1000n, { status: "pending" }),
        payment(cash, "tie", "2026-09-01", 1000n),
        payment(cash2, "tie", "2026-08-01", 1000n),
        payment(foreign, "merchant", "2026-09-01", 1000n, { userId: other }),
        payment(card, "payment", "2026-09-01", -5000n, {
          plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
        }),
        payment(cash, "bank payment", "2026-09-04", 5100n), // inclusive boundaries
        payment(card, "unflagged payment", "2026-08-01", -6000n),
        payment(cash, "bank payment", "2026-08-02", 6000n),
        payment(card, "refund", "2026-09-15", -7777n), // no cash match
        payment(card, "ambiguous", "2026-07-01", -8000n),
        payment(cash, "ambiguous", "2026-07-01", 8000n),
        payment(cash2, "ambiguous", "2026-07-01", 8000n),
      ]);
      const proposed = await previewPaidFrom(userId, db, "2026-10-01");
      expect(proposed).toEqual(
        expect.arrayContaining([
          { billId: majority, accountId: cash, votes: 2, samples: 3 },
          { billId: transfer, accountId: cash, votes: 2, samples: 2 },
        ]),
      );
      expect(proposed).toHaveLength(2);
      await expect(
        db.transaction((tx) =>
          inferPaidFromInMutation(userId, tx, "2026-10-01", []),
        ),
      ).rejects.toThrow("evidence changed");
      expect((await db.select().from(auditLog)).length).toBe(0);
      await expect(
        db.transaction(async (tx) => {
          await inferPaidFromInMutation(userId, tx, "2026-10-01");
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await previewPaidFrom(userId, db, "2026-10-01")).toEqual(proposed);
      await db.transaction((tx) =>
        inferPaidFromInMutation(userId, tx, "2026-10-01"),
      );
      expect(await previewPaidFrom(userId, db, "2026-10-01")).toEqual([]);
      await db.transaction((tx) =>
        inferPaidFromInMutation(userId, tx, "2026-10-01"),
      );
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, userId));
      expect(audits).toHaveLength(2);
      expect(
        audits.every((a) => a.action === "update" && a.source === "system"),
      ).toBe(true);
      const rows = await db.select().from(billSetup);
      expect(rows.find((r) => r.id === chosen)?.accountId).toBe(cash2);
      expect(rows.find((r) => r.id === external)?.paidFromExternal).toBe(true);
      expect(rows.find((r) => r.id === tie)?.accountId).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});
