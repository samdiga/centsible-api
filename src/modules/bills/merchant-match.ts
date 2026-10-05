import { normalizeMerchant } from "./recurring-engine.js";

/** Bank-statement filler that says nothing about who was paid. */
const NOISE_TOKENS = new Set([
  "pmt",
  "payment",
  "bill",
  "ach",
  "debit",
  "online",
  "web",
  "des",
  "id",
  "indn",
  "co",
  "ppd",
  "pos",
  "purchase",
  "recurring",
  "autopay",
]);

const MIN_COMPACT_LENGTH = 4;
const TOKEN_OVERLAP = 0.6;
const SIMILARITY = 0.8;

const tokensOf = (normalized: string): string[] =>
  normalized.split(" ").filter((token) => token && !NOISE_TOKENS.has(token));

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * `inner` (spaces removed) appears in `outer` starting at a word start, so
 * "pseg" is found in "pseg elec" and "pse g", but "ally" is not in "tally".
 */
function containsAtWordStart(outer: string[], inner: string): boolean {
  if (inner.length < MIN_COMPACT_LENGTH) return false;
  return outer.some((_, index) =>
    outer.slice(index).join("").startsWith(inner),
  );
}

function namesMatch(left: string, right: string): boolean {
  const leftTokens = tokensOf(left);
  const rightTokens = tokensOf(right);
  if (!leftTokens.length || !rightTokens.length) return false;
  const leftCompact = leftTokens.join("");
  const rightCompact = rightTokens.join("");
  if (
    containsAtWordStart(rightTokens, leftCompact) ||
    containsAtWordStart(leftTokens, rightCompact)
  )
    return true;
  const [shorter, longer] =
    leftTokens.length <= rightTokens.length
      ? [leftTokens, new Set(rightTokens)]
      : [rightTokens, new Set(leftTokens)];
  const shared = new Set(shorter.filter((token) => longer.has(token))).size;
  if (shared / new Set(shorter).size >= TOKEN_OVERLAP) return true;
  if (Math.min(leftCompact.length, rightCompact.length) < MIN_COMPACT_LENGTH)
    return false;
  const distance = levenshtein(leftCompact, rightCompact);
  return (
    1 - distance / Math.max(leftCompact.length, rightCompact.length) >=
    SIMILARITY
  );
}

/**
 * Whether a transaction's merchant is plausibly the bill's payee. Bank
 * descriptors add or drop characters ("DISNEY PLUS ADY" for Disney+,
 * "PSEG ELEC PMT" for PSE&G), so names match on word-start containment,
 * shared tokens, or near-identical spelling rather than equality.
 */
export function merchantMatchesBill(
  billNames: ReadonlyArray<string | null | undefined>,
  transactionNames: ReadonlyArray<string | null | undefined>,
): boolean {
  const normalize = (values: ReadonlyArray<string | null | undefined>) => [
    ...new Set(
      values.flatMap((value) => (value ? [normalizeMerchant(value)] : [])),
    ),
  ];
  const bills = normalize(billNames).filter(Boolean);
  const transactions = normalize(transactionNames).filter(Boolean);
  return bills.some((bill) =>
    transactions.some((transaction) => namesMatch(bill, transaction)),
  );
}

export type BillMatchSetup = {
  accountId: string | null;
  billType: string;
  canonicalName: string;
  displayName: string | null;
  merchantPatterns: string[];
  /** For a transfer bill: the destination account's names and bank. */
  payeeNames?: string[] | undefined;
};
export type BillMatchPayment = {
  accountId: string;
  date: string;
  amount: bigint;
  isCard: boolean;
  merchantName: string | null;
  name: string;
};
export type BillMatchMismatch =
  "amount" | "date" | "card_on_transfer" | "account" | "merchant";

const MATCH_WINDOW_MS = 7 * 86_400_000;

export const daysApartMs = (left: string, right: string): number =>
  Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`));

/**
 * Why a payment cannot settle an expense occurrence, or null when it can.
 * All must hold: exact amount, within 7 days, on the bill's Paid-from
 * account when it has one, and from the bill's merchant. A card purchase
 * never pays a transfer (card-payment) bill.
 */
export function billPaymentMismatch(
  setup: BillMatchSetup,
  occurrence: { amount: bigint; date: string },
  payment: BillMatchPayment,
): BillMatchMismatch | null {
  if (payment.amount <= 0n || payment.amount !== occurrence.amount)
    return "amount";
  if (daysApartMs(payment.date, occurrence.date) > MATCH_WINDOW_MS)
    return "date";
  return billPayeeMismatch(setup, payment);
}

/** The account and merchant half of the rule, for links already made. */
export function billPayeeMismatch(
  setup: BillMatchSetup,
  payment: Omit<BillMatchPayment, "date" | "amount">,
): BillMatchMismatch | null {
  if (payment.isCard && setup.billType === "transfer")
    return "card_on_transfer";
  if (setup.accountId && setup.accountId !== payment.accountId)
    return "account";
  if (
    !merchantMatchesBill(
      [
        setup.canonicalName,
        setup.displayName,
        ...setup.merchantPatterns,
        ...(setup.payeeNames ?? []),
      ],
      [payment.merchantName, payment.name],
    )
  )
    return "merchant";
  return null;
}

export type MatchCandidate = {
  occurrenceId: string;
  transactionId: string;
  distanceMs: number;
};

/**
 * Pairs occurrences with payments that qualify for them. A pair is linked
 * only when each is the other's unique closest-dated choice; a tie on
 * either side is left for the user. (A weekly bill's next occurrence is
 * often within the window too, so "qualifies for one occurrence only"
 * would never link it.)
 */
export function pairClosest(
  candidates: ReadonlyArray<MatchCandidate>,
): Map<string, string> {
  const closest = (key: "occurrenceId" | "transactionId") => {
    const best = new Map<string, { other: string | null; distance: number }>();
    for (const candidate of candidates) {
      const id = candidate[key];
      const other =
        key === "occurrenceId"
          ? candidate.transactionId
          : candidate.occurrenceId;
      const current = best.get(id);
      if (!current || candidate.distanceMs < current.distance)
        best.set(id, { other, distance: candidate.distanceMs });
      else if (candidate.distanceMs === current.distance)
        best.set(id, { other: null, distance: current.distance });
    }
    return best;
  };
  const byOccurrence = closest("occurrenceId");
  const byTransaction = closest("transactionId");
  const pairs = new Map<string, string>();
  for (const [occurrenceId, { other }] of byOccurrence)
    if (other && byTransaction.get(other)?.other === occurrenceId)
      pairs.set(occurrenceId, other);
  return pairs;
}
