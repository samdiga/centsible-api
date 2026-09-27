import { describe, expect, it } from "vitest";
import { UpdateAccountBodySchema } from "../accounts.schemas.js";
import {
  UpdateBillBodySchema,
  UpdateBillOccurrenceBodySchema,
} from "../../bills/bills.schemas.js";

describe("card payment request boundaries", () => {
  it.each(["full", "planned", "interest_saving"])(
    "accepts %s and integer planned cents",
    (rule) => {
      expect(
        UpdateAccountBodySchema.parse({
          cardPaymentRule: rule,
          cardPlannedPaymentCents: "5000",
        }),
      ).toMatchObject({
        cardPaymentRule: rule,
        cardPlannedPaymentCents: 5000n,
      });
    },
  );
  it.each(["-1", "1.5", "9223372036854775808"])(
    "rejects invalid payment cents %s",
    (amount) => {
      expect(
        UpdateAccountBodySchema.safeParse({ cardPlannedPaymentCents: amount })
          .success,
      ).toBe(false);
      expect(
        UpdateBillOccurrenceBodySchema.safeParse({
          paymentOverrideCents: amount,
        }).success,
      ).toBe(false);
    },
  );
  it("preserves null clears and explicit external source switches", () => {
    expect(
      UpdateAccountBodySchema.parse({
        cardPaymentRule: "full",
        cardPlannedPaymentCents: null,
      }),
    ).toMatchObject({ cardPlannedPaymentCents: null });
    expect(
      UpdateBillOccurrenceBodySchema.parse({ paymentOverrideCents: null }),
    ).toEqual({ paymentOverrideCents: null });
    expect(
      UpdateBillOccurrenceBodySchema.parse({ paymentOverrideCents: "0" }),
    ).toEqual({ paymentOverrideCents: 0n });
    expect(
      UpdateBillBodySchema.parse({ paidFromExternal: true, accountId: null }),
    ).toEqual({ paidFromExternal: true, accountId: null });
  });
});
