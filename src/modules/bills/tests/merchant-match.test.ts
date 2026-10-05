import { describe, expect, it } from "vitest";
import { merchantMatchesBill, pairClosest } from "../merchant-match.js";

describe("merchantMatchesBill", () => {
  it.each([
    ["Disney+", "DISNEY PLUS ADY"],
    ["PSE&G", "PSEG ELEC PMT"],
    ["Roundpoint", "ROUNDPOINT MORTGAGE SERVICING"],
    ["Volvo Car Finance", "VOLVO CAR FIN PMT"],
    ["Geico", "GEICO*AUTO"],
    ["Netflix", "NETFLIX.COM"],
    ["Verizon Wireless", "VERIZON WIRELSS PAYMENT"],
    ["Capital One Venture", "CAPITAL ONE MOBILE PMT"],
    ["Fidelity", "FIDELITY INVESTMENTS"],
  ])("matches %s to %s", (bill, transaction) => {
    expect(merchantMatchesBill([bill], [transaction])).toBe(true);
  });

  it.each([
    ["Robinhood", "FIDELITY INVESTMENTS"],
    ["Adobe", "AMAZON"],
    ["Ally", "TALLY HO CAFE"],
    ["Capital One", "CAPITAL GRILLE"],
    ["Hulu", "HULA BOWL"],
    ["ACH Payment", "ACH DEBIT ONLINE PMT"],
  ])("does not match %s to %s", (bill, transaction) => {
    expect(merchantMatchesBill([bill], [transaction])).toBe(false);
  });

  it("matches on any bill name or learned pattern against either transaction name", () => {
    expect(
      merchantMatchesBill(
        ["Mortgage", null, "roundpoint mortgage servicing"],
        [null, "ROUNDPOINT MTG SERVICING 0042"],
      ),
    ).toBe(true);
  });

  it("does not match when either side has no usable name", () => {
    expect(merchantMatchesBill([], ["NETFLIX"])).toBe(false);
    expect(merchantMatchesBill(["Netflix"], [null, ""])).toBe(false);
    expect(merchantMatchesBill(["123"], ["123"])).toBe(false);
  });
});

describe("pairClosest", () => {
  const day = 86_400_000;
  it("links mutual closest pairs and leaves ties unlinked", () => {
    const pairs = pairClosest([
      { occurrenceId: "week1", transactionId: "t1", distanceMs: 0 },
      { occurrenceId: "week2", transactionId: "t1", distanceMs: 7 * day },
      { occurrenceId: "week2", transactionId: "t2", distanceMs: day },
      { occurrenceId: "tied", transactionId: "t3", distanceMs: 2 * day },
      { occurrenceId: "tied", transactionId: "t4", distanceMs: 2 * day },
    ]);
    expect([...pairs]).toEqual([
      ["week1", "t1"],
      ["week2", "t2"],
    ]);
  });

  it("does not link a payment equally close to two occurrences", () => {
    expect(
      pairClosest([
        { occurrenceId: "a", transactionId: "t", distanceMs: 3 * day },
        { occurrenceId: "b", transactionId: "t", distanceMs: 3 * day },
      ]).size,
    ).toBe(0);
  });
});
