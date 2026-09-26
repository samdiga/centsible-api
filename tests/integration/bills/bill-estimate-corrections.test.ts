import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { billSetup, users } from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
import {
  createBillsService,
  runBillDetection,
  materializeBillsForUser,
} from "../../../src/modules/bills/bills.service.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";
import { UpdateBillBodySchema } from "../../../src/modules/bills/bills.schemas.js";
import type { DetectionTransaction } from "../../../src/modules/bills/recurring-engine.js";
const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();
guardedDescribe("pending estimate corrections", () => {
  it.each([false, true])(
    "keeps a corrected %s estimate until a newer payment and preserves detection identity",
    async (isIncome) => {
      const testDb = await createIsolatedTestDatabase();
      try {
        const { db } = testDb,
          userId = randomUUID();
        await db
          .insert(users)
          .values({ id: userId, email: `${userId}@example.test`, name: "U" });
        const sign = isIncome ? -1n : 1n;
        const repository = createBillsRepository(db);
        const dates = ["2026-07-01", "2026-08-01", "2026-09-01"];
        let transactions: DetectionTransaction[] = dates.map((date) => ({
          merchantName: "Example",
          name: "Example",
          date,
          amountCents: 8000n * sign,
          isIncome,
          isTransfer: false,
          excludeFromBudgets: false,
          ...(isIncome ? { plaidCategoryDetailed: "INCOME_WAGES" } : {}),
        }));
        const deps = {
          repository: {
            ...repository,
            detectionTransactions: async () => transactions,
          },
          withUserMutation: async <T>(
            _id: string,
            cb: Parameters<typeof db.transaction<T>>[0],
          ) => db.transaction(cb),
          billDispatcher: {
            detect: async () => {},
            materialize: async () => {},
          },
        };
        await runBillDetection(userId, deps);
        const [before] = await repository.list(userId);
        const service = createBillsService(deps);
        const corrected = await service.updateBill(
          userId,
          before!.id,
          UpdateBillBodySchema.parse({
            amountCents: "9500",
            cadence: "weekly",
            nextExpectedDate: "2026-10-15",
            status: "active",
            userConfirmed: true,
          }),
        );
        expect(corrected).toMatchObject({
          avgAmountCents: (9500n * sign).toString(),
          cadence: "weekly",
          nextExpectedDate: "2026-10-15",
        });
        const occurrences = createBillOccurrencesRepository(db);
        await materializeBillsForUser(userId, before!.id, 1, {
          ...deps,
          occurrences,
          now: () => new Date("2026-10-01T12:00:00Z"),
        });
        const generated = await occurrences.listBySetup(userId, before!.id);
        expect(generated.map((row) => row.dueDate).sort()).toEqual([
          "2026-10-15",
          "2026-10-22",
          "2026-10-29",
        ]);
        expect(
          generated.every((row) => row.expectedAmountCents === 9500n * sign),
        ).toBe(true);
        expect(await runBillDetection(userId, deps)).toEqual({
          created: 0,
          updated: 0,
        });
        transactions = [
          ...transactions,
          {
            ...transactions[0]!,
            date: "2026-10-01",
            amountCents: 10000n * sign,
          },
        ];
        expect(await runBillDetection(userId, deps)).toEqual({
          created: 0,
          updated: 1,
        });
        await repository.updateDetection(userId, [
          {
            id: before!.id,
            lastOccurredOn: "2026-09-01",
            nextExpectedDate: "2026-09-08",
            lastAmountCents: 1n * sign,
            avgAmountCents: 1n * sign,
            sampleCount: 3,
          },
        ]);
        await materializeBillsForUser(userId, before!.id, 1, {
          ...deps,
          occurrences,
          now: () => new Date("2026-10-01T12:00:00Z"),
        });
        const refreshed = await occurrences.listBySetup(userId, before!.id);
        expect(
          refreshed.every((row) => row.expectedAmountCents === 8000n * sign),
        ).toBe(true);
        const rows = await db
          .select()
          .from(billSetup)
          .where(eq(billSetup.userId, userId));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          cadence: "monthly",
          cadenceOverride: "weekly",
          avgAmount: 8000n * sign,
          nextExpectedDate: "2026-10-08",
        });
        await expect(
          service.updateBill(
            userId,
            before!.id,
            UpdateBillBodySchema.parse({ amountCents: "11000" }),
          ),
        ).rejects.toThrow("before confirming");
      } finally {
        await testDb.cleanup();
      }
    },
    120_000,
  );
});
