export type AccountForNetWorth = Readonly<{
  type: "depository" | "credit" | "loan" | "investment" | "other";
  currentBalance: bigint | null;
  availableBalance: bigint | null;
  excludeFromNetWorth: boolean;
  excludeFromForecast: boolean;
}>;

export type NetWorthResult = Readonly<{
  netWorth: bigint;
  assets: bigint;
  liabilities: bigint;
  safeToSpend: bigint;
}>;

/** Computes net worth and liquid safe-to-spend without performing I/O. */
export function computeNetWorth(
  accounts: readonly AccountForNetWorth[],
  upcomingBillsTotal: bigint = 0n,
): NetWorthResult {
  let assets = 0n;
  let liabilities = 0n;
  let liquid = 0n;

  for (const account of accounts) {
    const balance = account.currentBalance ?? 0n;
    if (!account.excludeFromNetWorth) {
      if (account.type === "depository" || account.type === "investment") {
        assets += balance;
      } else if (account.type === "credit" || account.type === "loan") {
        liabilities += balance < 0n ? -balance : balance;
      }
    }
    if (account.type === "depository" && !account.excludeFromForecast) {
      liquid += account.availableBalance ?? account.currentBalance ?? 0n;
    }
  }

  return {
    netWorth: assets - liabilities,
    assets,
    liabilities,
    safeToSpend: liquid - upcomingBillsTotal,
  };
}
