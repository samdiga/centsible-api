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
  dueDate,
  amount: BigInt(dollars * 100),
  cadence: "monthly",
  status: "upcoming",
  hasPayment: false,
  ...overrides,
});

const summarise = async (bills: UpcomingBillRow[]) => {
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
    getNetWorthHistory: vi.fn(async () => []),
  };
  const service = createDashboardService({
    repository,
    getUserRevision: async () => 1n,
    now: () => new Date(`${TODAY}T15:00:00Z`),
  });
  return { summary: await service.getSummary(USER_ID), repository };
};

describe("dashboard upcoming bills", () => {
  it("asks for bills from the service's own date", async () => {
    const { repository } = await summarise([]);
    expect(repository.getUpcomingBills).toHaveBeenCalledWith(USER_ID, TODAY);
  });

  it("lists only what's still to pay, with each occurrence's own date and amount", async () => {
    const { summary } = await summarise([
      bill("Late", "2026-09-20", 40, { status: "overdue" }),
      bill("Power", "2026-10-07", 85),
      bill("By hand", "2026-10-08", 60, { status: "processing" }),
      bill("Held", "2026-10-06", 30, {
        status: "processing",
        hasPayment: true,
      }),
    ]);
    expect(
      summary.upcomingBills.map((row) => [
        row.name,
        row.nextExpectedDate,
        row.avgAmount,
      ]),
    ).toEqual([
      ["Late", "2026-09-20", "4000"],
      ["Power", "2026-10-07", "8500"],
    ]);
    expect(summary.upcomingBills[0]).toMatchObject({
      occurrenceId: expect.any(String),
    });
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

  it("shows five bills but counts every bill due this week", async () => {
    const week = Array.from({ length: 7 }, (_, index) =>
      bill(
        `Bill ${index}`,
        `2026-10-0${index + 5 > 9 ? 9 : index + 5}`,
        10 + index,
      ),
    );
    const { summary } = await summarise(week);
    expect(summary.upcomingBills).toHaveLength(5);
    const total = week.reduce((sum, row) => sum + Number(row.amount), 0);
    expect(summary.safeToSpend).toBe(String(500_000 - total));
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
