import { describe, expect, it, vi } from "vitest";

import type {
  DashboardRepository,
  UpcomingBillRow,
} from "../dashboard.repository.js";
import { createDashboardService } from "../dashboard.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-10-05";

const bill = (
  name: string,
  dueDate: string,
  dollars: number,
  overrides: Partial<UpcomingBillRow> = {},
): UpcomingBillRow => ({
  id: `22222222-2222-4222-8222-${String(name.length).padStart(12, "0")}`,
  occurrenceId: `33333333-3333-4333-8333-${String(dollars).padStart(12, "0")}`,
  canonicalName: name.toLowerCase(),
  displayName: name,
  accountLabel: null,
  dueDate,
  amount: BigInt(dollars * 100),
  cadence: "monthly",
  status: "upcoming",
  hasPayment: false,
  payFromAccountId: null,
  billType: "payable",
  toAccountId: null,
  ...overrides,
});

const CHECKING = "44444444-4444-4444-8444-444444444444";
const CARD = "55555555-5555-4555-8555-555555555555";

const summarise = async (
  bills: UpcomingBillRow[],
  projectCardPayments = vi.fn(async () => [
    { cardAccountId: CARD, dueDate: "2026-10-20", paymentCents: 12_000n },
  ]),
) => {
  const repository: DashboardRepository = {
    listAccounts: vi.fn(async () => [
      {
        type: "depository" as const,
        currentBalance: 500_000n,
        availableBalance: 500_000n,
        excludeFromNetWorth: false,
        excludeFromForecast: false,
      },
    ]),
    getSpendingTotals: vi.fn(async () => ({ thisMonth: 0n, lastMonth: 0n })),
    getUpcomingBills: vi.fn(async () => bills),
    listCashAccounts: vi.fn(async () => [
      { id: CHECKING, name: "Checking", currentBalance: 300_000n },
    ]),
    getUserTimezone: vi.fn(async () => "America/Los_Angeles"),
    getNetWorthHistory: vi.fn(async () => []),
  };
  const service = createDashboardService({
    repository,
    getUserRevision: async () => 1n,
    now: () => new Date(`${TODAY}T15:00:00Z`),
    projectCardPayments,
    logger: { error: vi.fn() },
  });
  return {
    summary: await service.getSummary(USER_ID),
    repository,
    projectCardPayments,
  };
};

describe("dashboard upcoming bills", () => {
  it("asks for bills from the service's own date", async () => {
    const { repository } = await summarise([]);
    // Through the month's end (Oct 31) when that's past the two-week list.
    expect(repository.getUpcomingBills).toHaveBeenCalledWith(
      USER_ID,
      TODAY,
      26,
    );
  });

  it("lists what's still to pay and flags bills marked paid by hand", async () => {
    const { summary } = await summarise([
      bill("Late", "2026-09-20", 40, { status: "overdue" }),
      bill("Power", "2026-10-07", 85),
      bill("By hand", "2026-10-08", 60, { status: "processing" }),
      bill("Held", "2026-10-06", 30, {
        status: "processing",
        hasPayment: true,
      }),
    ]);
    // "Held" has a pending charge at the bank: never listed.
    expect(
      summary.upcomingBills.map((row) => [
        row.name,
        row.nextExpectedDate,
        row.avgAmount,
        row.markedPaid,
      ]),
    ).toEqual([
      ["Late", "2026-09-20", "4000", false],
      ["Power", "2026-10-07", "8500", false],
      ["By hand", "2026-10-08", "6000", true],
    ]);
    expect(summary.upcomingBills[0]).toMatchObject({
      occurrenceId: expect.any(String),
    });
  });

  it("names a card bill after the user's account unless the bill has its own name (T-185)", async () => {
    const { summary } = await summarise([
      bill("Card", "2026-10-07", 85, {
        canonicalName: "credit card payment",
        displayName: null,
        accountLabel: "Chase Freedom payment",
      }),
      bill("Own", "2026-10-08", 60, {
        canonicalName: "credit card payment",
        displayName: "Freedom",
        accountLabel: "Chase Freedom payment",
      }),
    ]);
    expect(summary.upcomingBills.map((row) => row.name)).toEqual([
      "Chase Freedom payment",
      "Freedom",
    ]);
  });

  it("takes from safe-to-spend what hasn't left yet, within a week", async () => {
    const { summary } = await summarise([
      bill("Late", "2026-09-20", 40, { status: "overdue" }),
      bill("Power", "2026-10-07", 85),
      // Marked paid by hand, no payment yet: the money is still here.
      bill("By hand", "2026-10-08", 60, { status: "processing" }),
      // A pending charge is attached: the bank already counts it.
      bill("Held", "2026-10-06", 30, {
        status: "processing",
        hasPayment: true,
      }),
      // Due after this week: listed, not subtracted.
      bill("Next week", "2026-10-15", 500),
    ]);
    expect(summary.safeToSpend).toBe(String(500_000 - (4000 + 8500 + 6000)));
    expect(summary.safeToSpendHasBills).toBe(true);
    expect(summary.upcomingBills.map((row) => row.name)).toContain("Next week");
  });

  it("lists ten unpaid bills, counts them all, and counts every bill due this week", async () => {
    // Oct 5 to Oct 16: all inside the two-week list window.
    const bills = Array.from({ length: 12 }, (_, index) =>
      bill(
        `Bill ${index}`,
        `2026-10-${String(5 + index).padStart(2, "0")}`,
        10 + index,
      ),
    );
    const { summary } = await summarise(bills);
    expect(summary.upcomingBills).toHaveLength(10);
    expect(summary.upcomingBillsUnpaidCount).toBe(12);
    // Safe to spend takes the week (through Oct 12), listed or not.
    const week = bills.filter((row) => row.dueDate <= "2026-10-12");
    const total = week.reduce((sum, row) => sum + Number(row.amount), 0);
    expect(summary.safeToSpend).toBe(String(500_000 - total));
  });

  it("keeps ten unpaid bills when marked-paid ones fall among them, and doesn't count those", async () => {
    // Oct 5 to Oct 19, the last day of the list window.
    const rows = Array.from({ length: 15 }, (_, index) =>
      bill(
        `Row ${index}`,
        `2026-10-${String(5 + index).padStart(2, "0")}`,
        20 + index,
        // Every third row is marked paid by hand.
        index % 3 === 1 ? { status: "processing" } : {},
      ),
    );
    const { summary } = await summarise(rows);
    const unpaidListed = summary.upcomingBills.filter((row) => !row.markedPaid);
    expect(unpaidListed).toHaveLength(10);
    // 15 rows, 5 of them marked paid (indexes 1, 4, 7, 10, 13).
    expect(summary.upcomingBillsUnpaidCount).toBe(10);
    // Marked-paid rows among the first ten unpaid are listed too, flagged.
    expect(summary.upcomingBills.filter((row) => row.markedPaid)).toHaveLength(
      5,
    );
  });

  it("listing marked-paid bills leaves safe-to-spend unchanged", async () => {
    const withHand = await summarise([
      bill("Power", "2026-10-07", 85),
      bill("By hand", "2026-10-08", 60, { status: "processing" }),
    ]);
    // T-128/T-140 rule: a hand-marked bill counts until its payment posts.
    expect(withHand.summary.safeToSpend).toBe(String(500_000 - (8500 + 6000)));
  });

  it("has no bills to subtract when everything is settled", async () => {
    const { summary } = await summarise([]);
    expect(summary).toMatchObject({
      upcomingBills: [],
      safeToSpend: "500000",
      safeToSpendHasBills: false,
    });
  });
});

describe("dashboard safe to spend by account", () => {
  it("subtracts this month's bills paid from the account, with the period end", async () => {
    const { summary, projectCardPayments } = await summarise([
      bill("Rent", "2026-10-06", 1000, { payFromAccountId: CHECKING }),
      bill("By hand", "2026-10-08", 60, {
        status: "processing",
        payFromAccountId: CHECKING,
      }),
      bill("Held", "2026-10-09", 30, {
        status: "processing",
        hasPayment: true,
        payFromAccountId: CHECKING,
      }),
      bill("November", "2026-11-01", 500, { payFromAccountId: CHECKING }),
      bill("Nowhere", "2026-10-12", 70),
    ]);
    expect(summary.periodEnd).toBe("2026-10-31");
    expect(summary.safeToSpendByAccount).toEqual([
      {
        accountId: CHECKING,
        name: "Checking",
        balanceCents: "300000",
        billsDueCents: String(100_000 + 6000),
        safeToSpendCents: String(300_000 - 106_000),
        billCount: 2,
      },
    ]);
    expect(summary.unassignedBillCount).toBe(1);
    // No card payments due: the engine isn't run.
    expect(projectCardPayments).not.toHaveBeenCalled();
  });

  it("counts a card payment at the engine's projected amount", async () => {
    const { summary, projectCardPayments } = await summarise([
      bill("Card payment", "2026-10-20", 900, {
        billType: "transfer",
        toAccountId: CARD,
        payFromAccountId: CHECKING,
      }),
    ]);
    expect(projectCardPayments).toHaveBeenCalledWith(
      USER_ID,
      TODAY,
      "2026-10-31",
    );
    expect(summary.safeToSpendByAccount[0]).toMatchObject({
      billsDueCents: "12000",
      safeToSpendCents: String(300_000 - 12_000),
    });
  });

  it("falls back to the statement amount when the projection fails", async () => {
    const { summary } = await summarise(
      [
        bill("Card payment", "2026-10-20", 900, {
          billType: "transfer",
          toAccountId: CARD,
          payFromAccountId: CHECKING,
        }),
      ],
      vi.fn(async () => {
        throw new Error("engine down");
      }),
    );
    expect(summary.safeToSpendByAccount[0]?.billsDueCents).toBe("90000");
  });
});
