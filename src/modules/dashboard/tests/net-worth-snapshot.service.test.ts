import { expect, it, vi } from "vitest";
import type { UserMutationService } from "../../../platform/cache/user-revisions.repository.js";
import type { DashboardAccountRow } from "../dashboard.repository.js";
import { createNetWorthSnapshotService } from "../net-worth-snapshot.service.js";

it("upserts a JSON-safe daily net-worth snapshot inside one user mutation", async () => {
  const upsert = vi.fn(async () => "snapshot-id");
  const audit = vi.fn(async () => undefined);
  const accounts: DashboardAccountRow[] = [
    {
      type: "depository",
      currentBalance: 500_00n,
      availableBalance: 450_00n,
      excludeFromNetWorth: false,
      excludeFromForecast: false,
    },
    {
      type: "credit",
      currentBalance: 125_00n,
      availableBalance: null,
      excludeFromNetWorth: false,
      excludeFromForecast: false,
    },
  ];
  const withUserMutation = vi.fn(
    async <T>(
      _userId: string,
      callback: Parameters<UserMutationService["withUserMutation"]>[1],
    ) => callback({} as never) as Promise<T>,
  );
  const service = createNetWorthSnapshotService({
    listAccounts: vi.fn(async () => accounts),
    upsert,
    audit,
    withUserMutation:
      withUserMutation as UserMutationService["withUserMutation"],
    now: () => new Date("2026-09-09T12:00:00Z"),
  });

  await expect(service.snapshot("user-id")).resolves.toEqual({
    date: "2026-09-09",
    netWorthCents: "37500",
  });
  expect(upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      date: "2026-09-09",
      totalAssets: 500_00n,
      totalLiabilities: 125_00n,
      netWorth: 375_00n,
      liquidAssets: 450_00n,
      breakdown: { depository: 50000, credit: 12500 },
    }),
    expect.anything(),
  );
  expect(audit).toHaveBeenCalledWith(
    expect.objectContaining({
      after: expect.objectContaining({ netWorthCents: "37500" }),
    }),
    expect.anything(),
  );
  expect(withUserMutation).toHaveBeenCalledOnce();
});
