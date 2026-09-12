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

describe("updateRule", () => {
  it("maps wire money and tag action fields to persistence columns", async () => {
    const { rulesRepository } = await import("../rules.repository.js");
    let persistedPatch: unknown;
    const set = vi.fn((value: unknown) => {
      persistedPatch = value;
      return {
        where: () => ({
          returning: () => Promise.resolve([{ id: "rule-1" }]),
        }),
      };
    });

    await rulesRepository.updateRule(
      "rule-1",
      "user-1",
      {
        matchAmountMin: "-500",
        matchAmountMax: null,
        actionAddTagIds: ["tag-1"],
      },
      { update: () => ({ set }) } as never,
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        matchAmountMin: -500n,
        matchAmountMax: null,
        actionAddTags: ["tag-1"],
        updatedAt: expect.any(Date),
      }),
    );
    expect(persistedPatch).not.toHaveProperty("actionAddTagIds");
  });
});
