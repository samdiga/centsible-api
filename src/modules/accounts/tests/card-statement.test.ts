import { describe, expect, it } from "vitest";

import {
  deriveStatement,
  dueDateAfter,
  lastStatementDate,
} from "../card-statement.js";

describe("card statement from the user's days", () => {
  it.each([
    // statement day, today, last statement date
    [3, "2026-10-06", "2026-10-03"],
    [6, "2026-10-06", "2026-10-06"], // today is the statement day
    [20, "2026-10-06", "2026-09-20"],
    [31, "2026-10-06", "2026-09-30"], // September has 30 days
    [31, "2026-10-31", "2026-10-31"],
    [30, "2026-03-01", "2026-02-28"], // February
    [29, "2028-03-01", "2028-02-29"], // leap year
    [15, "2026-01-10", "2025-12-15"], // across the year
  ])("statement day %i on %s closed on %s", (day, today, expected) => {
    expect(lastStatementDate(day, today)).toBe(expected);
  });

  it.each([
    // statement date, due day, due date
    ["2026-10-03", 28, "2026-10-28"], // later the same month
    ["2026-09-20", 15, "2026-10-15"], // early next month
    ["2026-10-31", 31, "2026-11-30"], // never on the close itself
    ["2026-01-31", 30, "2026-02-28"],
    ["2026-12-20", 10, "2027-01-10"],
  ])("closed %s, due day %i -> due %s", (close, day, expected) => {
    expect(dueDateAfter(close, day)).toBe(expected);
  });

  it("takes out what posted after the statement: charges and payments", () => {
    // Owed now $1,250; since the close: $300 of charges, a $500 payment.
    expect(
      deriveStatement(
        {
          statementDay: 3,
          paymentDueDay: 28,
          currentBalance: 125_000n,
          postedSinceStatement: 30_000n - 50_000n,
        },
        "2026-10-06",
      ),
    ).toEqual({
      statementDate: "2026-10-03",
      paymentDueDate: "2026-10-28",
      statementBalance: 145_000n,
    });
  });

  it("leaves the balance unknown when the card has none", () => {
    expect(
      deriveStatement(
        {
          statementDay: 3,
          paymentDueDay: 28,
          currentBalance: null,
          postedSinceStatement: 0n,
        },
        "2026-10-06",
      ).statementBalance,
    ).toBeNull();
  });
});
