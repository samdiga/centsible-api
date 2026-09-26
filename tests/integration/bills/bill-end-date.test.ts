import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  billSetup,
  billOccurrences,
  forecastEvents,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
import {
  createBillsService,
  materializeBillsForUser,
} from "../../../src/modules/bills/bills.service.js";
import { UpdateBillBodySchema } from "../../../src/modules/bills/bills.schemas.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
  getTransactionBackendPid,
  waitForBlockedBackend,
} from "../../support/test-database.js";
const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();
guardedDescribe("bill end dates", () => {
  it("limits generation inclusively, cancels effective future dates, and restores only end-date cancellations", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID(),
        otherUserId = randomUUID();
      await db.insert(users).values(
        [userId, otherUserId].map((id) => ({
          id,
          email: `${id}@example.test`,
          name: "U",
        })),
      );
      const repository = createBillsRepository(db),
        occurrences = createBillOccurrencesRepository(db);
      const deps = {
        repository,
        occurrences,
        now: () => new Date("2026-10-01T12:00:00Z"),
        withUserMutation: async <T>(
          _id: string,
          cb: Parameters<typeof db.transaction<T>>[0],
        ) => db.transaction(cb),
        billDispatcher: { detect: async () => {}, materialize: async () => {} },
      };
      const service = createBillsService(deps);
      const [bill] = await db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "End date test",
          cadence: "weekly",
          avgAmount: 8000n,
          nextExpectedDate: "2026-10-01",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const [otherBill] = await db
        .insert(billSetup)
        .values({
          userId: otherUserId,
          canonicalName: "Other tenant",
          cadence: "weekly",
          avgAmount: 1n,
          nextExpectedDate: "2026-10-01",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      await materializeBillsForUser(userId, bill!.id, 1, deps);
      const generated = await occurrences.listBySetup(userId, bill!.id);
      const at = (date: string) =>
        generated.find((row) => row.dueDate === date)!;
      await db
        .update(billOccurrences)
        .set({ status: "paid", linkedTransactionId: null })
        .where(eq(billOccurrences.id, at("2026-10-22").id));
      await db
        .update(billOccurrences)
        .set({ status: "processing" })
        .where(eq(billOccurrences.id, at("2026-10-29").id));
      await db
        .update(billOccurrences)
        .set({ dueDateOverride: "2026-10-20" })
        .where(eq(billOccurrences.id, at("2026-10-08").id));
      await db.insert(billOccurrences).values([
        {
          userId,
          billSetupId: bill!.id,
          occurrenceKey: "manual-cancel",
          dueDate: "2026-10-30",
          expectedAmountCents: 1n,
          status: "cancelled",
        },
        {
          userId,
          billSetupId: bill!.id,
          occurrenceKey: "history",
          dueDate: "2026-09-20",
          expectedAmountCents: 1n,
          status: "overdue",
        },
        {
          userId: otherUserId,
          billSetupId: otherBill!.id,
          occurrenceKey: "other",
          dueDate: "2026-10-30",
          expectedAmountCents: 1n,
        },
      ]);
      await expect(
        service.updateBill(otherUserId, bill!.id, { endDate: "2026-10-15" }),
      ).rejects.toThrow();
      const updated = await service.updateBill(
        userId,
        bill!.id,
        UpdateBillBodySchema.parse({ endDate: "2026-10-15" }),
      );
      expect(updated.endDate).toBe("2026-10-15");
      let rows = await occurrences.listBySetup(userId, bill!.id);
      expect(rows.find((row) => row.id === at("2026-10-08").id)).toMatchObject({
        status: "cancelled",
        cancelledByEndDate: true,
      });
      expect(rows.find((row) => row.dueDate === "2026-10-15")?.status).toBe(
        "upcoming",
      );
      expect(rows.find((row) => row.dueDate === "2026-10-22")?.status).toBe(
        "paid",
      );
      expect(rows.find((row) => row.dueDate === "2026-10-29")?.status).toBe(
        "processing",
      );
      expect(rows.find((row) => row.dueDate === "2026-09-20")?.status).toBe(
        "overdue",
      );
      const events = await db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.userId, userId));
      expect(
        events.find((row) => row.billOccurrenceId === at("2026-10-08").id)
          ?.deletedAt,
      ).not.toBeNull();
      expect(
        events.find((row) => row.billOccurrenceId === at("2026-10-29").id)
          ?.deletedAt,
      ).toBeNull();
      await service.updateBill(userId, bill!.id, { endDate: null });
      rows = await occurrences.listBySetup(userId, bill!.id);
      expect(rows.find((row) => row.id === at("2026-10-08").id)).toMatchObject({
        status: "upcoming",
        cancelledByEndDate: null,
        dueDateOverride: "2026-10-20",
      });
      expect(
        rows.find((row) => row.occurrenceKey === "manual-cancel")?.status,
      ).toBe("cancelled");
      expect(
        (await occurrences.listBySetup(otherUserId, otherBill!.id))[0]?.status,
      ).toBe("upcoming");
      expect(
        (
          await db
            .select()
            .from(forecastEvents)
            .where(eq(forecastEvents.billOccurrenceId, at("2026-10-08").id))
        )[0]?.deletedAt,
      ).toBeNull();
      const limited = await service.createBill(userId, {
        canonicalName: "Limited",
        amountCents: 1n,
        cadence: "weekly",
        nextExpectedDate: "2026-10-01",
        endDate: "2026-10-15",
        isIncome: false,
        billType: "payable",
      });
      await materializeBillsForUser(userId, limited.id, 1, deps);
      expect(
        (await occurrences.listBySetup(userId, limited.id)).map(
          (row) => row.dueDate,
        ),
      ).toEqual(["2026-10-01", "2026-10-08", "2026-10-15"]);
      // Hold materialization after its locked read, then prove the update waits on that exact backend.
      const peer = await testDb.createPeerClient(),
        observer = await testDb.createPeerClient();
      let release!: () => void, locked!: () => void, updateStarted!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const started = new Promise<void>((resolve) => {
        updateStarted = resolve;
      });
      let holderPid = 0,
        waiterPid = 0;
      const materializing = materializeBillsForUser(userId, limited.id, 1, {
        ...deps,
        repository: {
          ...repository,
          list: async (id, statuses, tx, lock) => {
            const rows = await repository.list(id, statuses, tx, lock);
            if (!tx || !("rollback" in tx))
              throw new Error("Expected a transaction for materialization");
            holderPid = await getTransactionBackendPid(tx);
            locked();
            await gate;
            return rows;
          },
        },
      });
      await acquired;
      const peerService = createBillsService({
        ...deps,
        repository: createBillsRepository(peer.db),
        occurrences: createBillOccurrencesRepository(peer.db),
        withUserMutation: async <T>(
          _id: string,
          cb: Parameters<typeof db.transaction<T>>[0],
        ) =>
          peer.db.transaction(async (tx) => {
            waiterPid = await getTransactionBackendPid(tx);
            updateStarted();
            return cb(tx);
          }),
      });
      const ending = peerService.updateBill(userId, limited.id, {
        endDate: "2026-10-01",
      });
      try {
        await started;
        await waitForBlockedBackend(observer.client, waiterPid, holderPid);
      } finally {
        release();
        await Promise.all([materializing, ending]);
      }
      expect(
        (await occurrences.listBySetup(userId, limited.id))
          .filter((row) => row.status === "upcoming")
          .map((row) => row.dueDate),
      ).toEqual(["2026-10-01"]);
      await expect(
        service.updateOccurrence(
          userId,
          limited.id,
          (await occurrences.listBySetup(userId, limited.id))[0]!.id,
          { dueDate: "2026-10-02" },
        ),
      ).rejects.toThrow("after the bill end date");
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
