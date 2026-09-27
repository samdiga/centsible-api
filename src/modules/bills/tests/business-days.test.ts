import { describe, expect, it } from "vitest";
import {
  bankHolidays,
  isBusinessDay,
  looksSemimonthly,
  nextSemimonthlyPayDate,
  onOrBeforeBusinessDay,
  semimonthlyPayDates,
} from "../business-days.js";

describe("business days", () => {
  it("knows the 2026 Federal Reserve holidays, not moving a Saturday holiday", () => {
    expect([...bankHolidays(2026)].sort()).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-05-25",
      "2026-06-19",
      "2026-07-04",
      "2026-09-07",
      "2026-10-12",
      "2026-11-11",
      "2026-11-26",
      "2026-12-25",
    ]);
    // Independence Day 2026 is a Saturday; the Fed is open on Friday the 3rd.
    expect(isBusinessDay("2026-07-03")).toBe(true);
    expect(isBusinessDay("2026-11-26")).toBe(false);
  });

  it("moves weekends and holidays to the business day before", () => {
    expect(onOrBeforeBusinessDay("2026-09-15")).toBe("2026-09-15");
    expect(onOrBeforeBusinessDay("2026-11-15")).toBe("2026-11-13"); // Sunday
    expect(onOrBeforeBusinessDay("2027-02-15")).toBe("2027-02-12"); // Presidents' Day
  });
});

describe("semi-monthly pay dates", () => {
  it("are the 15th and the last business day, each moved off weekends and holidays", () => {
    expect(semimonthlyPayDates(2026, 8)).toEqual(["2026-08-14", "2026-08-31"]);
    expect(semimonthlyPayDates(2026, 10)).toEqual(["2026-10-15", "2026-10-30"]);
    expect(semimonthlyPayDates(2026, 11)).toEqual(["2026-11-13", "2026-11-30"]);
    expect(semimonthlyPayDates(2027, 2)).toEqual(["2027-02-12", "2027-02-26"]);
  });

  it("steps to the next pay date across month and year ends", () => {
    expect(nextSemimonthlyPayDate("2026-10-15")).toBe("2026-10-30");
    expect(nextSemimonthlyPayDate("2026-10-30")).toBe("2026-11-13");
    expect(nextSemimonthlyPayDate("2026-12-31")).toBe("2027-01-15");
    expect(nextSemimonthlyPayDate("2026-11-01")).toBe("2026-11-13");
  });

  it("recognises a semi-monthly deposit history but not a biweekly one", () => {
    expect(
      looksSemimonthly(["2026-08-14", "2026-08-31", "2026-09-15", "2026-09-30"]),
    ).toBe(true);
    // A deposit posting a day late (Oct 30 pay date, posted Oct 31) still counts.
    expect(
      looksSemimonthly(["2026-09-15", "2026-09-30", "2026-10-15", "2026-10-31"]),
    ).toBe(true);
    expect(
      looksSemimonthly(["2026-08-07", "2026-08-21", "2026-09-04", "2026-09-18"]),
    ).toBe(false);
    // Only mid-month dates: that's monthly on the 15th, not semi-monthly.
    expect(
      looksSemimonthly(["2026-08-14", "2026-09-15", "2026-10-15"]),
    ).toBe(false);
  });
});
