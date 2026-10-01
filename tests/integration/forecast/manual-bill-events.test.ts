import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accounts,
  billOccurrences,
  billSetup,
  forecastEvents,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { getAccountForecastInputs } from "../../../src/modules/forecast/forecast-accounts.repository.js";
import { generateAccountsForecast } from "../../../src/modules/forecast/engine/accounts.js";
import { createForecastRepository } from "../../../src/modules/forecast/forecast.repository.js";
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

guardedDescribe("manually marked bill forecast", () => {
  it("keeps unlinked bills in both engines, routes marked amounts, and avoids duplicate card payments", async () => {
    const fixture = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const checking = randomUUID();
      const alternate = randomUUID();
      const card = randomUUID();
      await fixture.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      await fixture.db.insert(accounts).values([
        {
          id: checking,
          userId,
          name: "Checking",
          type: "depository" as const,
          subtype: "checking" as const,
          currentBalance: 100_000n,
        },
        {
          id: alternate,
          userId,
          name: "Other checking",
          type: "depository" as const,
          subtype: "checking" as const,
          currentBalance: 20_000n,
        },
        {
          id: card,
          userId,
          name: "Card",
          type: "credit" as const,
          subtype: "credit_card" as const,
          currentBalance: 12_000n,
          statementBalance: 8_000n,
          statementDate: "2026-09-05",
          paymentDueDate: "2026-10-03",
        },
      ]);
      const cases = [
        {
          name: "Past cash bill",
          due: "2026-09-30",
          expected: 1_200n,
          marked: 1_500n,
          status: "processing",
          setupAccount: checking,
          paidAccount: alternate,
          billType: "payable",
        },
        {
          name: "Card charge",
          due: "2026-10-02",
          expected: 2_500n,
          marked: 2_700n,
          status: "processing",
          setupAccount: card,
          paidAccount: card,
          billType: "payable",
        },
        {
          name: "Card transfer",
          due: "2026-10-03",
          expected: 8_000n,
          marked: 10_000n,
          status: "processing",
          setupAccount: null,
          paidAccount: checking,
          billType: "transfer",
        },
        {
          name: "Pending charge",
          due: "2026-10-04",
          expected: 400n,
          marked: null,
          status: "processing",
          setupAccount: checking,
          paidAccount: null,
          billType: "payable",
        },
        {
          name: "Posted charge",
          due: "2026-10-05",
          expected: 500n,
          marked: null,
          status: "paid",
          setupAccount: checking,
          paidAccount: null,
          billType: "payable",
        },
        {
          name: "Unlinked paid",
          due: "2026-10-06",
          expected: 600n,
          marked: 650n,
          status: "paid",
          setupAccount: checking,
          paidAccount: alternate,
          billType: "payable",
        },
        {
          name: "Skipped",
          due: "2026-10-07",
          expected: 700n,
          marked: null,
          status: "skipped",
          setupAccount: checking,
          paidAccount: null,
          billType: "payable",
        },
        {
          name: "Cancelled",
          due: "2026-10-08",
          expected: 800n,
          marked: null,
          status: "cancelled",
          setupAccount: checking,
          paidAccount: null,
          billType: "payable",
        },
      ] as const;
      const setupIds = cases.map(() => randomUUID());
      const occurrenceIds = cases.map(() => randomUUID());
      const [pending, posted] = await fixture.db
        .insert(transactions)
        .values([
          {
            userId,
            accountId: checking,
            name: "Pending charge",
            amount: 400n,
            date: "2026-10-04",
            status: "pending" as const,
            isRecurring: true,
          },
          {
            userId,
            accountId: checking,
            name: "Posted charge",
            amount: 500n,
            date: "2026-10-05",
            status: "posted" as const,
            isRecurring: true,
          },
        ])
        .returning({ id: transactions.id });
      await fixture.db.insert(billSetup).values(
        cases.map((item, index) => ({
          id: setupIds[index]!,
          userId,
          canonicalName: item.name,
          cadence: "monthly" as const,
          avgAmount: item.expected,
          accountId: item.setupAccount,
          paidFromExternal: item.setupAccount === null,
          toAccountId: item.billType === "transfer" ? card : null,
          billType: item.billType,
          status: "active" as const,
          userConfirmed: true,
        })),
      );
      await fixture.db.insert(billOccurrences).values(
        cases.map((item, index) => ({
          id: occurrenceIds[index]!,
          userId,
          billSetupId: setupIds[index]!,
          occurrenceKey: `${setupIds[index]}:${item.due}`,
          dueDate: item.due,
          expectedAmountCents: item.expected,
          status: item.status,
          paidAmountCents: item.marked,
          paidAccountId: item.paidAccount,
          markedPaidAt: item.marked === null ? null : new Date(),
          pendingTransactionId: index === 3 ? pending!.id : null,
          linkedTransactionId: index === 4 ? posted!.id : null,
        })),
      );
      await fixture.db.insert(forecastEvents).values(
        cases.map((item, index) => ({
          userId,
          name: item.name,
          amount: item.expected,
          date: item.due,
          accountId: item.setupAccount,
          recurringSeriesId: setupIds[index]!,
          billOccurrenceId: occurrenceIds[index]!,
          sourceType: "recurring" as const,
        })),
      );

      const today = "2026-10-01";
      const v1 = await createForecastRepository(fixture.db).getForecastInputs(
        userId,
        10,
        today,
      );
      expect(
        v1.events.map((event) => [event.name, event.date, event.amountCents]),
      ).toEqual([
        ["Past cash bill", today, 1_500n],
        ["Card charge", "2026-10-02", 2_700n],
        ["Card transfer", "2026-10-03", 10_000n],
        ["Unlinked paid", "2026-10-06", 650n],
      ]);

      const inputs = await getAccountForecastInputs(
        userId,
        10,
        today,
        fixture.db,
      );
      expect(
        inputs.events.map((event) => [
          event.name,
          event.date,
          event.amountCents,
          event.accountId,
        ]),
      ).toEqual([
        ["Past cash bill", today, 1_500n, alternate],
        ["Card charge", "2026-10-02", 2_700n, card],
        ["Unlinked paid", "2026-10-06", 650n, alternate],
      ]);
      const result = generateAccountsForecast({
        today,
        horizonDays: 10,
        ...inputs,
      });
      expect(result.cardStatements[0]?.payFromAccountId).toBe(checking);
      expect(
        result.accounts.find((row) => row.id === alternate)?.balances[0],
      ).toBe(18_500n);
      expect(result.accounts.find((row) => row.id === card)?.balances[2]).toBe(
        4_700n,
      );
      expect(
        result.days[2]?.events.filter((event) => event.amountCents === 10_000n),
      ).toHaveLength(1);
      expect(
        result.days[2]?.events.filter(
          (event) => event.amountCents === -10_000n,
        ),
      ).toHaveLength(1);
      expect(
        result.days
          .flatMap((day) => day.events)
          .some(
            (event) =>
              event.amountCents === 400n ||
              event.amountCents === 500n ||
              event.amountCents === 700n ||
              event.amountCents === 800n,
          ),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});
