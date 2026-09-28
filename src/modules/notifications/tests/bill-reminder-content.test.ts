import { describe, expect, it } from "vitest";
import {
  billDisplayName,
  buildBillReminder,
  type ReminderOccurrence,
} from "../bill-reminder-content.js";

const bill = (
  occurrenceId: string,
  name: string,
  dueDate: string,
  amountCents = 120000n,
): ReminderOccurrence => ({ occurrenceId, name, dueDate, amountCents });

const none = { due: new Set<string>(), overdue: new Set<string>() };

const build = (
  occurrences: ReminderOccurrence[],
  options: Partial<{
    hideAmounts: boolean;
    mentioned: { due: Set<string>; overdue: Set<string> };
    daysAhead: number;
  }> = {},
) =>
  buildBillReminder({
    localDate: "2026-09-28",
    daysAhead: options.daysAhead ?? 3,
    hideAmounts: options.hideAmounts ?? false,
    occurrences,
    mentioned: options.mentioned ?? none,
  });

describe("buildBillReminder", () => {
  it("names one bill with its amount and date", () => {
    expect(build([bill("r", "Rent", "2026-10-01", 185000n)])).toEqual({
      title: "Rent is due in 3 days",
      body: "Rent $1,850 is due Thu, Oct 1.",
      month: "2026-10-01",
      dueOccurrenceIds: ["r"],
      overdueOccurrenceIds: [],
    });
  });

  it("summarises several bills on one day with a whole-dollar total", () => {
    const content = build(
      [
        bill("r", "Rent", "2026-09-29", 185000n),
        bill("g", "Geico", "2026-09-29", 42050n),
        bill("p", "PSE&G", "2026-09-29", 37199n),
      ],
      { daysAhead: 1 },
    );
    expect(content?.title).toBe("3 bills are due tomorrow");
    expect(content?.body).toBe(
      "3 bills due Tue, Sep 29: Rent, Geico, PSE&G · $2,642 total.",
    );
  });

  it("keeps amounts off the lock screen when Blur amounts is on", () => {
    expect(
      build([bill("r", "Rent", "2026-10-01")], { hideAmounts: true })?.body,
    ).toBe("Rent is due Thu, Oct 1.");
    expect(
      build(
        [bill("r", "Rent", "2026-10-01"), bill("g", "Geico", "2026-10-01")],
        { hideAmounts: true },
      )?.body,
    ).toBe("2 bills due Thu, Oct 1: Rent, Geico.");
  });

  it("adds each overdue bill as a line, once", () => {
    const occurrences = [
      bill("r", "Rent", "2026-10-01", 185000n),
      bill("g", "Geico", "2026-09-20"),
    ];
    const first = build(occurrences);
    expect(first?.body).toBe(
      "Rent $1,850 is due Thu, Oct 1.\n1 overdue: Geico.",
    );
    expect(first?.overdueOccurrenceIds).toEqual(["g"]);
    expect(
      build(occurrences, {
        mentioned: { due: new Set(["r"]), overdue: new Set(["g"]) },
      }),
    ).toBeNull();
  });

  it("sends for overdue bills even with nothing else due", () => {
    const content = build([
      bill("g", "Geico", "2026-08-20"),
      bill("w", "Water", "2026-09-27"),
    ]);
    expect(content?.title).toBe("2 bills are overdue");
    expect(content?.body).toBe("2 overdue: Geico, Water.");
    expect(content?.month).toBe("2026-08-01");
  });

  it("still names a bill as overdue after it was reminded as due", () => {
    expect(
      build([bill("g", "Geico", "2026-09-27")], {
        mentioned: { due: new Set(["g"]), overdue: new Set() },
      })?.overdueOccurrenceIds,
    ).toEqual(["g"]);
  });

  it("catches up a bill added inside its lead time, once", () => {
    const occurrences = [bill("r", "Rent", "2026-09-29")];
    expect(build(occurrences)?.title).toBe("Rent is due tomorrow");
    expect(
      build(occurrences, {
        mentioned: { due: new Set(["r"]), overdue: new Set() },
      }),
    ).toBeNull();
  });

  it("sends nothing for bills beyond the lead time or for income", () => {
    expect(
      build([
        bill("later", "Rent", "2026-10-02"),
        bill("pay", "Payroll", "2026-09-29", -250000n),
      ]),
    ).toBeNull();
  });

  it("lists days in order when catch-up puts two due dates together", () => {
    const content = build([
      bill("b", "Phone", "2026-10-01", 5000n),
      bill("a", "Rent", "2026-09-28", 185000n),
    ]);
    expect(content?.title).toBe("2 bills are due soon");
    expect(content?.body).toBe(
      "Rent $1,850 is due Mon, Sep 28.\nPhone $50 is due Thu, Oct 1.",
    );
    expect(content?.month).toBe("2026-09-01");
  });
});

describe("billDisplayName", () => {
  it("prefers the user's name and capitalises lowercase detected names", () => {
    expect(billDisplayName("My rent", "rent")).toBe("My rent");
    expect(billDisplayName(null, "pse g")).toBe("Pse G");
    expect(billDisplayName("  ", "Costco Visa")).toBe("Costco Visa");
  });
});
