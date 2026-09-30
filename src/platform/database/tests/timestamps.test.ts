import { describe, expect, it } from "vitest";

import { toDateOrNull } from "../timestamps.js";

describe("toDateOrNull", () => {
  it("turns the driver's timestamptz string into a Date", () => {
    // What drizzle's postgres-js driver returns for min(timestamptz).
    const value = toDateOrNull("2026-09-30 13:00:00+00");
    expect(value).toBeInstanceOf(Date);
    expect(value?.toISOString()).toBe("2026-09-30T13:00:00.000Z");
  });

  it("passes a Date through and reads epoch milliseconds", () => {
    const date = new Date("2026-09-30T13:00:00Z");
    expect(toDateOrNull(date)).toBe(date);
    expect(toDateOrNull(date.getTime())).toEqual(date);
  });

  it("gives null for nothing, garbage or an invalid date", () => {
    for (const value of [null, undefined, "", "not a date", {}, new Date(NaN)])
      expect(toDateOrNull(value)).toBeNull();
  });
});
