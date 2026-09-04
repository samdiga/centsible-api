import { describe, expect, it } from "vitest";

import { computeNetWorth } from "../net-worth.js";

const account = (
  type: "depository" | "credit" | "loan" | "investment" | "other",
  currentBalance: bigint | null,
  availableBalance: bigint | null = null,
  excludeFromNetWorth = false,
  excludeFromForecast = false,
) => ({
  type,
  currentBalance,
  availableBalance,
  excludeFromNetWorth,
  excludeFromForecast,
});

describe("computeNetWorth", () => {
  it("computes assets minus absolute liabilities and liquid safe-to-spend", () => {
    const result = computeNetWorth(
      [
        account("depository", 300000n, 250000n),
        account("investment", 1200000n),
        account("credit", 50000n),
        account("loan", -100000n),
      ],
      20000n,
    );

    expect(result).toEqual({
      assets: 1500000n,
      liabilities: 150000n,
      netWorth: 1350000n,
      safeToSpend: 230000n,
    });
  });

  it("honors net-worth and forecast exclusions independently", () => {
    const result = computeNetWorth([
      account("depository", 500000n, null, true, false),
      account("depository", 400000n, null, false, true),
      account("investment", null),
    ]);

    expect(result).toEqual({
      assets: 400000n,
      liabilities: 0n,
      netWorth: 400000n,
      safeToSpend: 500000n,
    });
  });
});
