import { generateAccountsForecast } from "../../../src/modules/forecast/engine/accounts.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accounts,
  billSetup,
  forecastEvents,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { getAccountForecastInputs } from "../../../src/modules/forecast/forecast-accounts.repository.js";
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
guardedDescribe("account-aware forecast input SQL", () => {
  it("keeps missing v2 flag off, routes bills, removes payment duplicates and counts real payments separately from refunds", async () => {
    const fixture = await createIsolatedTestDatabase();
    try {
      const { db } = fixture,
        userId = randomUUID(),
        other = randomUUID(),
        cash = randomUUID(),
        card = randomUUID(),
        boa = randomUUID(),
        hidden = randomUUID(),
        bill = randomUUID(),
        transfer = randomUUID(),
        external = randomUUID();
      await db.insert(users).values(
        [userId, other].map((id) => ({
          id,
          name: "Fixture",
          email: `${id}@example.test`,
        })),
      );
      await db.insert(accounts).values([
        {
          id: cash,
          userId,
          name: "Cash",
          type: "depository",
          subtype: "checking",
          currentBalance: 100000n,
          apyOverride: 4,
        },
        {
          id: card,
          userId,
          name: "Card",
          type: "credit",
          subtype: "credit_card",
          currentBalance: 1000n,
          statementBalance: 10000n,
          statementDate: "2026-09-01",
          paymentDueDate: "2026-09-26",
        },
        {
          id: boa,
          userId,
          name: "No close",
          type: "credit",
          subtype: "credit_card",
          currentBalance: 1150000n,
          statementBalance: 1150000n,
          paymentDueDate: "2026-10-15",
        },
        {
          id: hidden,
          userId,
          name: "Hidden",
          type: "depository",
          subtype: "checking",
          currentBalance: 999999n,
          isHidden: true,
        },
      ]);
      await db.insert(billSetup).values([
        {
          id: bill,
          userId,
          canonicalName: "Service",
          cadence: "monthly",
          avgAmount: 100n,
          accountId: card,
          status: "active",
        },
        {
          id: transfer,
          userId,
          canonicalName: "Card payment",
          cadence: "monthly",
          avgAmount: 10000n,
          accountId: cash,
          toAccountId: card,
          billType: "transfer",
          status: "active",
        },
        {
          id: external,
          userId,
          canonicalName: "External",
          cadence: "monthly",
          avgAmount: 200n,
          paidFromExternal: true,
          status: "active",
        },
      ]);
      await db.insert(forecastEvents).values([
        {
          userId,
          name: "Card charge",
          date: "2026-09-25",
          amount: 100n,
          accountId: null,
          sourceType: "recurring",
          recurringSeriesId: bill,
        },
        {
          userId,
          name: "Duplicate card payment",
          date: "2026-09-26",
          amount: 10000n,
          accountId: cash,
          sourceType: "recurring",
          recurringSeriesId: transfer,
        },
        {
          userId,
          name: "External",
          date: "2026-09-25",
          amount: 200n,
          sourceType: "recurring",
          recurringSeriesId: external,
        },
      ]);
      const t = (
        accountId: string,
        date: string,
        amount: bigint,
        extra = {},
      ) => ({
        userId,
        accountId,
        date,
        amount,
        name: "Fixture transaction",
        ...extra,
      });
      await db.insert(transactions).values([
        t(card, "2026-09-10", -8000n, {
          plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
        }),
        t(cash, "2026-09-10", 8000n),
        t(card, "2026-09-12", -1000n), // refund, not payment
        t(card, "2026-09-01", 9000n),
        t(cash, "2026-09-01", 1900n),
        t(card, "2026-09-02", 50000n, { isRecurring: true }),
        t(card, "2026-09-03", 10000n, { name: "Service" }), // detected series without persisted flag
        t(cash, "2026-09-03", 10000n, { plaidCategoryPrimary: "TRANSFER_OUT" }),
        t(cash, "2026-09-02", 50000n, { excludeFromBudgets: true }),
        t(boa, "2026-06-01", -50000n, {
          plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
        }), // not a payment since derived current close
        t(hidden, "2026-09-01", 10000n),
        t(card, "2026-09-25", -500n, { status: "pending" }),
      ]);
      const savings = randomUUID();
      await db
        .insert(accounts)
        .values({
          id: savings,
          userId,
          name: "Savings",
          type: "depository",
          subtype: "checking",
          subtypeOverride: "savings",
          currentBalance: 500000n,
          apy: 1,
          apyOverride: 4,
        });
      await db
        .insert(transactions)
        .values([
          t(savings, "2026-06-30", -1000n, {
            plaidCategoryDetailed: "INCOME_INTEREST_EARNED",
          }),
          t(savings, "2026-07-31", -1000n, {
            plaidCategoryDetailed: "INCOME_INTEREST_EARNED",
          }),
          t(savings, "2026-08-31", -1000n, {
            plaidCategoryDetailed: "INCOME_INTEREST_EARNED",
          }),
          t(savings, "2026-09-10", 10000n, {
            plaidCategoryPrimary: "TRANSFER_OUT",
          }),
          t(savings, "2026-09-30", -1500n, {
            status: "pending",
            plaidCategoryDetailed: "INCOME_INTEREST_EARNED",
          }),
        ]);
      const repo = createForecastRepository(db);
      expect(
        await repo.isFeatureEnabled("nonexistent_legacy_flag", userId),
      ).toBe(true);
      expect(await repo.isFeatureEnabled("cash_horizon_accounts", userId)).toBe(
        false,
      );
      const result = await getAccountForecastInputs(
        userId,
        30,
        "2026-09-20",
        db,
      );
      expect(result.accounts).toHaveLength(4);
      expect(result.events).toHaveLength(4);
      expect(
        result.events.find((e) => e.recurringSeriesId === bill)?.accountId,
      ).toBe(card);
      expect(result.events.some((e) => e.recurringSeriesId === transfer)).toBe(
        false,
      );
      expect(
        result.events.find((e) => e.recurringSeriesId === external)
          ?.paidFromExternal,
      ).toBe(true);
      const c = result.accounts.find((a) => a.id === card)?.card;
      expect(c).toMatchObject({
        billedCents: 2000n,
        creditsSinceCloseCents: 1000n,
        paymentsSinceCloseCents: 8000n,
        unbilledCents: 0n,
      });
      expect(result.accounts.find((a) => a.id === boa)?.card?.billedCents).toBe(
        1150000n,
      );
      expect(
        result.accounts.find((a) => a.id === cash)?.savingsInterest,
      ).toBeUndefined();
      const interest = result.accounts.find(
        (a) => a.id === savings,
      )?.savingsInterest;
      expect(interest).toMatchObject({ apy: 4, creditDay: 31 });
      expect(interest!.accruedScaledCents > 0n).toBe(true);
      expect(
        result.events.find((e) => e.accountId === savings)?.interestDeposit,
      ).toBe(true);
      const projection = generateAccountsForecast({
        today: "2026-09-20",
        horizonDays: 30,
        ...result,
      });
      expect(
        projection.accounts.find((a) => a.id === savings)?.balances[10],
      ).toBe(501500n);
      expect(
        projection.days[10]?.events.some(
          (e) =>
            "accountId" in e &&
            e.accountId === savings &&
            e.sourceType === "savings_interest",
        ),
      ).toBe(false);
      expect(result.dailySpendByAccount.get(cash)).toBe(95n);
      expect(result.dailySpendByAccount.get(card)).toBe(450n);
      expect(
        (await getAccountForecastInputs(other, 30, "2026-09-20", db)).accounts,
      ).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 120000);
});
