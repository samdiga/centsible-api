import { describe, expect, it, vi } from "vitest";

describe("countMatchingTransactions", () => {
  it("returns 0 for merchant match types with no merchant given (unchanged behavior)", async () => {
    const { rulesRepository } = await import("../rules.repository.js");
    const count = await rulesRepository.countMatchingTransactions(
      "user-1",
      { matchType: "merchant_exact", matchMerchant: null },
      {
        select: () => ({
          from: () => ({ where: () => Promise.resolve([{ count: 5 }]) }),
        }),
      } as never,
    );
    expect(count).toBe(0);
  });

  it("evaluates amount_range with only a min bound set", async () => {
    const { rulesRepository } = await import("../rules.repository.js");
    const selectMock = vi.fn(() => ({
      from: () => ({ where: () => Promise.resolve([{ count: 3 }]) }),
    }));
    const count = await rulesRepository.countMatchingTransactions(
      "user-1",
      {
        matchType: "amount_range",
        matchAmountMin: 500n,
        matchAmountMax: null,
      },
      { select: selectMock } as never,
    );
    expect(count).toBe(3);
    expect(selectMock).toHaveBeenCalled();
  });
});
