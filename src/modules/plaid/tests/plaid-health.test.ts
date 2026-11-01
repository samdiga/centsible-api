import { describe, expect, it } from "vitest";
import { isBankNotRefreshing } from "../plaid-health.js";

const NOW = new Date("2026-10-29T22:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

describe("isBankNotRefreshing", () => {
  const healthy = {
    status: "active" as const,
    cursor: "c",
    lastSyncAt: hoursAgo(1),
    bankLastUpdatedAt: hoursAgo(1),
  };

  it.each([
    ["fresh bank refresh", {}, false],
    ["bank quiet past the threshold (Macy's: 14 days)", { bankLastUpdatedAt: hoursAgo(14 * 24) }, true],
    ["just inside the threshold", { bankLastUpdatedAt: hoursAgo(71) }, false],
    ["Plaid hasn't said yet", { bankLastUpdatedAt: null }, false],
    ["first sync still running", { cursor: null, bankLastUpdatedAt: hoursAgo(200) }, false],
    ["needs relink: that message wins", { status: "login_required" as const, bankLastUpdatedAt: hoursAgo(200) }, false],
    ["our own sync is stale: that message wins", { lastSyncAt: hoursAgo(100), bankLastUpdatedAt: hoursAgo(200) }, false],
  ])("%s", (_name, overrides, expected) => {
    expect(isBankNotRefreshing({ ...healthy, ...overrides }, NOW)).toBe(expected);
  });
});
