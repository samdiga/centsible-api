import { describe, expect, it } from "vitest";
import {
  billPayeeMismatch,
  merchantMatchesBill,
  pairClosest,
} from "../merchant-match.js";

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
    // Bank cut "GAS" to "GA" (real descriptor shape, ids redacted).
    [
      "Elizabeth Town Gas",
      "ELIZABETHTOWN GA DES:BP ELIZAB ID:XXXXX INDN:J DOE CO ID:XXXXX WEB",
    ],
    ["Spectrum Internet", "SPECTRUM INTERNE"],
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
    ["Amazon Prime", "AMAZON MKTPL"],
    ["Chase Card", "CHASE CREDIT CRD"],
    ["Geico", "GECKO MART"],
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

describe("billPayeeMismatch for a card statement bill", () => {
  const CHECKING = "checking";
  const platinum = {
    accountId: CHECKING,
    billType: "transfer",
    canonicalName: "Platinum Card® payment",
    displayName: null,
    merchantPatterns: [],
    payeeNames: ["Platinum Card", "Amex Platinum", "American Express"],
  };
  const payment = {
    accountId: CHECKING,
    date: "2026-10-02",
    amount: 110758n,
    isCard: false,
    merchantName: null,
    name: "AMEX EPAYMENT",
  };

  it("does not match the bank's name for the payment on its own", () => {
    expect(billPayeeMismatch(platinum, payment)).toBe("merchant");
  });

  it("matches when the card shows the same amount arriving within 5 days", () => {
    const withArrival = (date: string, amount = 110758n) => ({
      ...platinum,
      toAccountInflows: [
        { date: "2026-09-30", amount: 2131n },
        { date, amount },
      ],
    });
    expect(billPayeeMismatch(withArrival("2026-10-01"), payment)).toBeNull();
    expect(billPayeeMismatch(withArrival("2026-10-07"), payment)).toBeNull();
    expect(billPayeeMismatch(withArrival("2026-10-08"), payment)).toBe(
      "merchant",
    );
    expect(billPayeeMismatch(withArrival("2026-10-01", 110759n), payment)).toBe(
      "merchant",
    );
  });

  it("still requires the Paid-from account and never takes a card purchase", () => {
    const arrived = {
      ...platinum,
      toAccountInflows: [{ date: "2026-10-01", amount: 110758n }],
    };
    expect(billPayeeMismatch(arrived, { ...payment, accountId: "other" })).toBe(
      "account",
    );
    expect(
      billPayeeMismatch(
        { ...arrived, accountId: null },
        { ...payment, isCard: true },
      ),
    ).toBe("card_on_transfer");
  });

  it("does not use arrivals for a payable bill", () => {
    expect(
      billPayeeMismatch(
        {
          ...platinum,
          billType: "payable",
          toAccountInflows: [{ date: "2026-10-01", amount: 110758n }],
        },
        payment,
      ),
    ).toBe("merchant");
  });
});

describe("pairClosest with slot bills", () => {
  const day = 86_400_000;
  const twins = new Map([
    ["mon-1", { groupId: "fidelity $50|2026-10-05", slot: 1 }],
    ["mon-2", { groupId: "fidelity $50|2026-10-05", slot: 2 }],
    ["next-1", { groupId: "fidelity $50|2026-10-12", slot: 1 }],
    ["next-2", { groupId: "fidelity $50|2026-10-12", slot: 2 }],
  ]);
  const both = (transactionId: string, distanceMs: number) => [
    { occurrenceId: "mon-1", transactionId, distanceMs },
    { occurrenceId: "mon-2", transactionId, distanceMs },
  ];

  it("gives same-day twins one identical payment each, in slot order", () => {
    const pairs = pairClosest([...both("t-b", 0), ...both("t-a", 0)], twins);
    expect([...pairs].sort()).toEqual([
      ["mon-1", "t-a"],
      ["mon-2", "t-b"],
    ]);
  });

  it("without slots, identical twins stay a tie for the user", () => {
    expect(pairClosest([...both("t-a", 0), ...both("t-b", 0)]).size).toBe(0);
  });

  it("leaves the group alone when a third payment ties at the cut-off", () => {
    expect(
      pairClosest(
        [...both("t-a", 0), ...both("t-b", day), ...both("t-c", day)],
        twins,
      ).size,
    ).toBe(0);
  });

  it("counts only payments that qualify for every twin", () => {
    const pairs = pairClosest(
      [
        ...both("t-a", 0),
        { occurrenceId: "mon-1", transactionId: "t-only-one", distanceMs: 0 },
      ],
      twins,
    );
    expect([...pairs]).toEqual([["mon-1", "t-a"]]);
  });

  it("keeps this week's payments for this week's twins", () => {
    const next = (transactionId: string, distanceMs: number) => [
      { occurrenceId: "next-1", transactionId, distanceMs },
      { occurrenceId: "next-2", transactionId, distanceMs },
    ];
    const pairs = pairClosest(
      [
        ...both("t-a", 0),
        ...both("t-b", 0),
        ...next("t-a", 7 * day),
        ...next("t-b", 7 * day),
      ],
      twins,
    );
    expect([...pairs].sort()).toEqual([
      ["mon-1", "t-a"],
      ["mon-2", "t-b"],
    ]);
  });
});
