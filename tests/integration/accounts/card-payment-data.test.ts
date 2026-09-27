import { migrateSchema } from "../../../database/migrate.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  accounts,
  billSetup,
  billOccurrences,
  forecastEvents,
  users,
} from "../../../database/schema/index.js";
import { createAccountRepository } from "../../../src/modules/accounts/accounts.repository.js";
import { createAccountService } from "../../../src/modules/accounts/accounts.service.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsService } from "../../../src/modules/bills/bills.service.js";
import { UpdateAccountBodySchema } from "../../../src/modules/accounts/accounts.schemas.js";
import { UpdateBillOccurrenceBodySchema } from "../../../src/modules/bills/bills.schemas.js";
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

guardedDescribe("card payment data contract", () => {
  it("audits tenant-scoped settings, preserves them across bank sync and keeps v1 forecasts unchanged", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID(),
        otherId = randomUUID();
      await db.insert(users).values(
        [userId, otherId].map((id) => ({
          id,
          email: `${id}@example.test`,
          name: "Test",
        })),
      );
      const [cash, card] = await db
        .insert(accounts)
        .values([
          {
            userId,
            name: "Cash",
            type: "depository" as const,
            subtype: "checking" as const,
            currentBalance: 100000n,
          },
          {
            userId,
            name: "Card",
            type: "credit" as const,
            subtype: "credit_card" as const,
            currentBalance: 15000n,
            plaidAccountId: "bank-card",
            statementBalance: 12000n,
            paymentDueDate: "2026-10-01",
          },
        ])
        .returning();
      const mutate = async <T>(
        _id: string,
        cb: Parameters<typeof db.transaction<T>>[0],
      ) => db.transaction(cb);
      const accountRepository = createAccountRepository(db);
      const accountService = createAccountService({
        repository: accountRepository,
        withUserMutation: mutate,
      });
      await expect(
        accountService.updateAccount(userId, cash!.id, {
          cardPaymentRule: "planned",
          cardPlannedPaymentCents: 5000n,
        }),
      ).rejects.toThrow("credit accounts");
      await expect(
        accountService.updateAccount(userId, card!.id, {
          cardPaymentRule: "planned",
        }),
      ).rejects.toThrow("planned payment amount");
      await expect(
        accountService.updateAccount(otherId, card!.id, {
          cardPaymentRule: "full",
        }),
      ).rejects.toThrow();
      const planned = await accountService.updateAccount(
        userId,
        card!.id,
        UpdateAccountBodySchema.parse({
          cardPaymentRule: "planned",
          cardPlannedPaymentCents: "5000",
        }),
      );
      expect(planned).toMatchObject({
        cardPaymentRule: "planned",
        cardPlannedPaymentCents: "5000",
      });
      await expect(
        accountService.updateAccount(userId, card!.id, {
          cardPlannedPaymentCents: null,
        }),
      ).rejects.toThrow("planned payment amount");
      await accountRepository.updateLiabilities(userId, "bank-card", {
        lastPaymentCents: 4321n,
        lastPaymentDate: "2026-09-25",
        statementBalance: 13000n,
      });
      const fresh = await accountRepository.findById(userId, card!.id);
      expect(fresh).toMatchObject({
        cardPaymentRule: "planned",
        cardPlannedPaymentCents: 5000n,
        lastPaymentCents: 4321n,
        lastPaymentDate: "2026-09-25",
        statementBalance: 13000n,
      });
      const full = await accountService.updateAccount(userId, card!.id, {
        cardPaymentRule: "full",
        cardPlannedPaymentCents: null,
      });
      expect(full.cardPlannedPaymentCents).toBeNull();
      expect(full.lastPaymentCents).toBe("4321");
      const [bill, regular] = await db
        .insert(billSetup)
        .values([
          {
            userId,
            canonicalName: "Card payment",
            cadence: "monthly" as const,
            avgAmount: 12000n,
            billType: "transfer" as const,
            accountId: cash!.id,
            toAccountId: card!.id,
            status: "active" as const,
            userConfirmed: true,
            nextExpectedDate: "2026-10-01",
          },
          {
            userId,
            canonicalName: "Regular",
            cadence: "monthly" as const,
            avgAmount: 2000n,
            status: "active" as const,
            userConfirmed: true,
          },
        ])
        .returning();
      const [occ, normal] = await db
        .insert(billOccurrences)
        .values([
          {
            userId,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:2026-10`,
            dueDate: "2026-10-01",
            expectedAmountCents: 12000n,
          },
          {
            userId,
            billSetupId: regular!.id,
            occurrenceKey: `${regular!.id}:2026-10`,
            dueDate: "2026-10-01",
            expectedAmountCents: 2000n,
          },
        ])
        .returning();
      await db.insert(forecastEvents).values({
        userId,
        billOccurrenceId: occ!.id,
        recurringSeriesId: bill!.id,
        accountId: cash!.id,
        name: "Card payment",
        amount: 12000n,
        date: "2026-10-01",
        sourceType: "recurring",
      });
      const beforeForecast = await db.select().from(forecastEvents);
      const repository = createBillsRepository(db);
      const billService = createBillsService({
        repository,
        occurrences: createBillOccurrencesRepository(db),
        withUserMutation: mutate,
        billDispatcher: { detect: async () => {}, materialize: async () => {} },
      });
      await expect(
        billService.updateOccurrence(userId, regular!.id, normal!.id, {
          paymentOverrideCents: 1000n,
        }),
      ).rejects.toThrow("card statement");
      await expect(
        billService.updateOccurrence(otherId, bill!.id, occ!.id, {
          paymentOverrideCents: 5000n,
        }),
      ).rejects.toThrow();
      const adjusted = await billService.updateOccurrence(
        userId,
        bill!.id,
        occ!.id,
        UpdateBillOccurrenceBodySchema.parse({ paymentOverrideCents: "5000" }),
      );
      expect(adjusted).toMatchObject({
        paymentOverrideCents: "5000",
        expectedAmountCents: "12000",
        amountOverrideCents: null,
      });
      expect(await db.select().from(forecastEvents)).toEqual(beforeForecast);
      const cleared = await billService.updateOccurrence(
        userId,
        bill!.id,
        occ!.id,
        { paymentOverrideCents: null },
      );
      expect(cleared.paymentOverrideCents).toBeNull();
      await expect(
        billService.updateBill(userId, bill!.id, { paidFromExternal: true }),
      ).rejects.toThrow("cannot also");
      const external = await billService.updateBill(userId, bill!.id, {
        paidFromExternal: true,
        accountId: null,
      });
      expect(external).toMatchObject({
        paidFromExternal: true,
        accountId: null,
      });
      await expect(
        billService.updateBill(userId, bill!.id, { accountId: cash!.id }),
      ).rejects.toThrow("cannot also");
      const restored = await billService.updateBill(userId, bill!.id, {
        paidFromExternal: false,
        accountId: cash!.id,
      });
      expect(restored).toMatchObject({
        paidFromExternal: false,
        accountId: cash!.id,
      });
      await db
        .update(billOccurrences)
        .set({ status: "paid" })
        .where(eq(billOccurrences.id, occ!.id));
      await expect(
        billService.updateOccurrence(userId, bill!.id, occ!.id, {
          paymentOverrideCents: 5000n,
        }),
      ).rejects.toThrow("cannot be edited");
      const audits = await db.execute(
        sql`select entity_type, action, before_json, after_json from audit_log where user_id = ${userId}`,
      );
      expect(audits.length).toBeGreaterThanOrEqual(6);
      expect(JSON.stringify(audits)).toContain(
        '"cardPlannedPaymentCents":"5000"',
      );
      expect(JSON.stringify(audits)).toContain('"paymentOverrideCents":"5000"');
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("down and up migration round-trip preserves existing rows and reinstates safe defaults", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const id = randomUUID();
      await db
        .insert(users)
        .values({ id, email: `${id}@example.test`, name: "Test" });
      await db.insert(accounts).values({
        userId: id,
        name: "Existing",
        type: "depository",
        subtype: "checking",
        currentBalance: 12345n,
      });
      const peer = await testDb.createPeerClient();
      try {
        const before =
          await peer.client`select to_jsonb(a) - array['last_payment_cents','last_payment_date','card_payment_rule','card_planned_payment_cents'] as row from accounts a`;
        const down = await readFile(
          new URL(
            "../../../database/migrations/down/0020_card_payment_data.sql",
            import.meta.url,
          ),
          "utf8",
        );
        await peer.client.unsafe(down);
        expect(
          await peer.client`select to_jsonb(a) as row from accounts a`,
        ).toEqual(before);
        await migrateSchema(peer.client, testDb.schemaName);
        expect(
          await peer.client`select to_jsonb(a) - array['last_payment_cents','last_payment_date','card_payment_rule','card_planned_payment_cents'] as row from accounts a`,
        ).toEqual(before);
        expect(
          await peer.client`select card_payment_rule, card_planned_payment_cents from accounts`,
        ).toEqual([
          { card_payment_rule: "full", card_planned_payment_cents: null },
        ]);
      } finally {
        await peer.close();
      }
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
