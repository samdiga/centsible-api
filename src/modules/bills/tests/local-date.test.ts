import { describe, expect, it } from "vitest";
import { dateInTimeZone, isPastDue } from "../local-date.js";

describe("the user's own today", () => {
  it("is still the due date at 11pm in New York, though UTC is a day ahead", () => {
    expect(
      dateInTimeZone(new Date("2026-10-28T03:00:00Z"), "America/New_York"),
    ).toBe("2026-10-27");
  });

  it("falls back to the UTC date for an unknown zone name", () => {
    expect(dateInTimeZone(new Date("2026-10-28T03:00:00Z"), "Mars/Base")).toBe(
      "2026-10-28",
    );
  });
});

describe("past due", () => {
  it.each([
    ["2026-10-27", "2026-10-27", false],
    ["2026-10-28", "2026-10-27", false],
    ["2026-10-26", "2026-10-27", true],
  ])("a bill due %s on %s is past due: %s", (due, today, expected) => {
    expect(isPastDue(due, today)).toBe(expected);
  });
});
