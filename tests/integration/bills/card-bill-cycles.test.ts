import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  accounts,
  auditLog,
  billOccurrences,
  billSetup,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
import {
  createBillsService,
  materializeBillsForUser,
} from "../../../src/modules/bills/bills.service.js";
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
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
// The card's statement is read against the real date, so the fixtures are too.
const today = new Date().toISOString().slice(0, 10);
const due = shift(today, 15);

async function setUp() {
  const testDb = await createIsolatedTestDatabase();
  const { db } = testDb,
    userId = randomUUID();
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: "U" });
  const repository = createBillsRepository(db),
    occurrences = createBillOccurrencesRepository(db);
  const deps = {
    repository,
    occurrences,
    withUserMutation: async <T>(
      _id: string,
      cb: Parameters<typeof db.transaction<T>>[0],
    ) => db.transaction(cb),
    billDispatcher: { detect: async () => {}, materialize: async () => {} },
  };
  const card = async (name: string) => {
    const [row] = await db
      .insert(accounts)
      .values({
        userId,
        name,
        type: "credit",
        subtype: "credit_card",
        currentBalance: 60000n,
        statementBalance: 50000n,
        statementDate: shift(today, -10),
        paymentDueDate: due,
      })
      .returning();
    const [bill] = await db
      .insert(billSetup)
      .values({
        userId,
        billType: "transfer",
        toAccountId: row!.id,
        canonicalName: `${name} payment`,
        cadence: "monthly",
        avgAmount: 50000n,
        nextExpectedDate: due,
        dayOfMonth: Number(due.slice(-2)),
        status: "active",
        userConfirmed: true,
      })
      .returning();
    return bill!;
  };
  const rowsOf = (billId: string) =>
    db
      .select()
      .from(billOccurrences)
      .where(eq(billOccurrences.billSetupId, billId));
  return {
    testDb,
    db,
    userId,
    deps,
    service: createBillsService(deps),
    card,
    rowsOf,
  };
}

guardedDescribe("card payment bills can't be turned off", () => {
  it("deleting one skips only this cycle and keeps the bill", async () => {
    const { testDb, db, userId, deps, service, card, rowsOf } = await setUp();
    try {
      const bill = await card("Venture X");
      await materializeBillsForUser(userId, bill.id, 12, deps);
      expect((await rowsOf(bill.id)).map((row) => row.status)).toEqual([
        "upcoming",
      ]);

      await expect(service.deleteBill(userId, bill.id)).resolves.toBe(true);

      const [setup] = await db
        .select()
        .from(billSetup)
        .where(eq(billSetup.id, bill.id));
      expect(setup).toMatchObject({ deletedAt: null, status: "active" });
      const [skipped] = await rowsOf(bill.id);
      expect(skipped).toMatchObject({ status: "skipped", dueDate: due });
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, skipped!.id));
      expect(audits.map((row) => row.source)).toEqual([
        "bills.delete_card_cycle",
      ]);

      // The same statement doesn't bring the skipped cycle back.
      await materializeBillsForUser(userId, bill.id, 12, deps);
      expect((await rowsOf(bill.id)).map((row) => row.status)).toEqual([
        "skipped",
      ]);

      // Nothing left open: deleting again is refused, the bill stays.
      await expect(service.deleteBill(userId, bill.id)).rejects.toMatchObject({
        httpStatus: 409,
      });
      const [still] = await db
        .select()
        .from(billSetup)
        .where(eq(billSetup.id, bill.id));
      expect(still!.deletedAt).toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("deleting any other bill still stops it", async () => {
    const { testDb, db, userId, deps, service, rowsOf } = await setUp();
    try {
      const [bill] = await db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Netflix",
          cadence: "monthly",
          avgAmount: 1599n,
          nextExpectedDate: due,
          status: "active",
          userConfirmed: true,
        })
        .returning();
      await materializeBillsForUser(userId, bill!.id, 3, deps);
      await service.deleteBill(userId, bill!.id);
      const [setup] = await db
        .select()
        .from(billSetup)
        .where(eq(billSetup.id, bill!.id));
      expect(setup!.deletedAt).not.toBeNull();
      expect(
        (await rowsOf(bill!.id)).every((row) => row.status === "cancelled"),
      ).toBe(true);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("a statement brings back its month's cancelled estimate, but not a skipped or ended one", async () => {
    const { testDb, db, userId, deps, card, rowsOf } = await setUp();
    try {
      const [cancelled, skipped, ended] = await Promise.all([
        card("Savor"),
        card("Platinum"),
        card("Costco"),
      ]);
      const key = (billId: string) => `${billId}:${due.slice(0, 7)}`;
      await db.insert(billOccurrences).values([
        {
          userId,
          billSetupId: cancelled.id,
          occurrenceKey: key(cancelled.id),
          dueDate: shift(due, -2),
          status: "cancelled",
          expectedAmountCents: 999n,
        },
        {
          userId,
          billSetupId: skipped.id,
          occurrenceKey: key(skipped.id),
          dueDate: due,
          status: "skipped",
          expectedAmountCents: 999n,
        },
        {
          userId,
          billSetupId: ended.id,
          occurrenceKey: key(ended.id),
          dueDate: due,
          status: "cancelled",
          cancelledByEndDate: true,
          expectedAmountCents: 999n,
        },
      ]);
      await materializeBillsForUser(userId, undefined, 12, deps);

      expect(await rowsOf(cancelled.id)).toEqual([
        expect.objectContaining({
          status: "upcoming",
          dueDate: due,
          expectedAmountCents: 50000n,
        }),
      ]);
      expect(await rowsOf(skipped.id)).toEqual([
        expect.objectContaining({ status: "skipped", expectedAmountCents: 999n }),
      ]);
      expect(await rowsOf(ended.id)).toEqual([
        expect.objectContaining({
          status: "cancelled",
          expectedAmountCents: 999n,
        }),
      ]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
