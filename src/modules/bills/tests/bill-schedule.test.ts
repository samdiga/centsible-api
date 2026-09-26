import { describe, expect, it } from "vitest";
import {
  nonCollidingScheduleDates,
  safeScheduleDates,
} from "../bill-schedule.js";
const billId = "bill";
const row = (patch = {}) => ({
  occurrenceKey: "bill:2026-10",
  dueDate: "2026-10-15",
  dueDateOverride: null,
  expectedAmountOverrideCents: null,
  status: "upcoming",
  linkedTransactionId: null,
  markedPaidAt: null,
  ...patch,
});
describe("schedule regeneration", () => {
  it("preserves a paid monthly cycle, even when its scheduled date changes", () => {
    expect(
      safeScheduleDates(
        billId,
        "monthly",
        "2026-10-01",
        ["2026-10-20", "2026-11-20"],
        [row({ status: "paid" })],
      ),
    ).toEqual(["2026-11-20"]);
  });
  it("protects overridden dates and amounts and processing payments from duplicate generation", () => {
    expect(
      safeScheduleDates(
        billId,
        "weekly",
        "2026-10-01",
        ["2026-10-15", "2026-10-22", "2026-10-29"],
        [
          row({ dueDateOverride: "2026-10-22" }),
          row({
            occurrenceKey: "bill:2026-10-29",
            dueDate: "2026-10-29",
            status: "processing",
          }),
        ],
      ),
    ).toEqual([]);
  });
  it("can reuse dates retired by an earlier schedule, but not unrelated cancellations", () => {
    expect(
      safeScheduleDates(
        billId,
        "weekly",
        "2026-10-01",
        ["2026-10-15"],
        [row({ status: "cancelled", occurrenceKey: "bill:rescheduled:old" })],
      ),
    ).toEqual(["2026-10-15"]);
    expect(
      safeScheduleDates(
        billId,
        "weekly",
        "2026-10-01",
        ["2026-10-15"],
        [row({ status: "cancelled" })],
      ),
    ).toEqual([]);
  });
});

it("a later worker run keeps older protected cycles even if no ordinary rows were retired", () => {
  expect(
    nonCollidingScheduleDates(
      billId,
      "weekly",
      ["2026-10-15", "2026-10-22"],
      [row({ status: "processing" })],
    ),
  ).toEqual(["2026-10-22"]);
  expect(
    nonCollidingScheduleDates(
      billId,
      "monthly",
      ["2026-10-15"],
      [row({ expectedAmountOverrideCents: 9000n })],
    ),
  ).toEqual(["2026-10-15"]);
});
