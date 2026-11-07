import { describe, expect, it } from "vitest";
import { billName } from "../bill-name.js";

describe("billName", () => {
  const card = {
    displayName: null,
    accountLabel: "Chase Freedom payment",
    canonicalName: "CREDIT CARD payment",
  };

  it("uses the user's own bill name first", () => {
    expect(billName({ ...card, displayName: "Freedom" })).toBe("Freedom");
  });

  it("names a card bill after the user's account, not the bank's name", () => {
    expect(billName(card)).toBe("Chase Freedom payment");
  });

  it("falls back to the detected name", () => {
    expect(
      billName({ displayName: null, accountLabel: null, canonicalName: "rent" }),
    ).toBe("rent");
  });

  it("skips blank names", () => {
    expect(billName({ ...card, displayName: "  " })).toBe(
      "Chase Freedom payment",
    );
    expect(billName({ ...card, accountLabel: " " })).toBe(
      "CREDIT CARD payment",
    );
  });
});
