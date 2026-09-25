import { describe, expect, it } from "vitest";
import {
  dollarsToCents,
  mapAccountSubtype,
  mapAccountType,
} from "../accounts.repository.js";

describe("accounts repository mappings", () => {
  it("rounds Plaid dollars deterministically to cents", () => {
    expect(dollarsToCents(123.456)).toBe(12346n);
    expect(dollarsToCents(null)).toBeNull();
    expect(dollarsToCents(undefined)).toBeNull();
  });

  it("normalizes unsupported account values", () => {
    expect(mapAccountType("DEPOSITORY")).toBe("depository");
    expect(mapAccountType("unsupported")).toBe("other");
    expect(mapAccountSubtype("credit-card")).toBe("credit_card");
    expect(mapAccountSubtype("credit card")).toBe("credit_card");
    expect(mapAccountSubtype("line of credit")).toBe("line_of_credit");
    expect(mapAccountSubtype("unsupported")).toBe("other");
  });
});
