import type { CardPaymentProjection } from "../forecast/index.js";
import { isMarkedPaid, moneyStillToLeave } from "./bill-money.js";
import type {
  CashAccountRow,
  UpcomingBillRow,
} from "./dashboard.repository.js";

export type AccountSafeToSpend = Readonly<{
  accountId: string;
  name: string;
  balanceCents: bigint;
  billsDueCents: bigint;
  safeToSpendCents: bigint;
  billCount: number;
}>;

export type SafeToSpendByAccount = Readonly<{
  accounts: AccountSafeToSpend[];
  /** Bills due in the period with no Paid-from account: not subtracted. */
  unassignedBillCount: number;
}>;

/** A card payment counts what the engine projects, not the full statement. */
const needsProjection = (bill: UpcomingBillRow) =>
  bill.billType === "transfer" &&
  bill.toAccountId !== null &&
  !isMarkedPaid(bill);

/** Whether any bill due by `periodEnd` needs the engine's card projection. */
export const needsCardProjections = (
  bills: readonly UpcomingBillRow[],
  periodEnd: string,
) =>
  bills.some(
    (bill) =>
      bill.dueDate <= periodEnd &&
      bill.payFromAccountId !== null &&
      needsProjection(bill),
  );

function billAmount(
  bill: UpcomingBillRow,
  cardPayments: readonly CardPaymentProjection[],
): bigint {
  if (!needsProjection(bill)) return bill.amount;
  const month = bill.dueDate.slice(0, 7);
  const projection = cardPayments.find(
    (payment) =>
      payment.cardAccountId === bill.toAccountId &&
      payment.dueDate.slice(0, 7) === month,
  );
  return projection?.paymentCents ?? bill.amount;
}

/**
 * Each cash account's current balance less the bills paid from it that are
 * due by `periodEnd` and whose money hasn't left yet. Income is never in
 * `bills`; expected income is deliberately not added.
 */
export function computeSafeToSpendByAccount(
  input: Readonly<{
    accounts: readonly CashAccountRow[];
    bills: readonly UpcomingBillRow[];
    cardPayments: readonly CardPaymentProjection[];
    periodEnd: string;
  }>,
): SafeToSpendByAccount {
  const totals = new Map(
    input.accounts.map((account) => [account.id, { due: 0n, count: 0 }]),
  );
  let unassignedBillCount = 0;
  for (const bill of input.bills) {
    if (bill.dueDate > input.periodEnd || !moneyStillToLeave(bill)) continue;
    if (bill.payFromAccountId === null) {
      unassignedBillCount += 1;
      continue;
    }
    // Paid from a card, a hidden account or another non-cash account.
    const total = totals.get(bill.payFromAccountId);
    if (!total) continue;
    total.due += billAmount(bill, input.cardPayments);
    total.count += 1;
  }
  return {
    accounts: input.accounts.map((account) => {
      const total = totals.get(account.id)!;
      const balanceCents = account.currentBalance ?? 0n;
      return {
        accountId: account.id,
        name: account.name,
        balanceCents,
        billsDueCents: total.due,
        safeToSpendCents: balanceCents - total.due,
        billCount: total.count,
      };
    }),
    unassignedBillCount,
  };
}
