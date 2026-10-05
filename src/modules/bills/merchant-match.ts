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
/** Short names are too easy to hit by accident with a typo allowance. */
const MIN_TRUNCATED_LENGTH = 6;

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

/**
 * Banks truncate descriptors ("ELIZABETHTOWN GA" for Elizabethtown Gas), so
 * a long name also matches a same-length stretch of `outer` that starts at a
 * word and differs by at most a fifth of its characters.
 */
function nearAtWordStart(outer: string[], inner: string): boolean {
  if (inner.length < MIN_TRUNCATED_LENGTH) return false;
  return outer.some((_, index) => {
    const window = outer.slice(index).join("").slice(0, inner.length);
    return 1 - levenshtein(inner, window) / inner.length >= SIMILARITY;
  });
}

function namesMatch(left: string, right: string): boolean {
  const leftTokens = tokensOf(left);
  const rightTokens = tokensOf(right);
  if (!leftTokens.length || !rightTokens.length) return false;
  const leftCompact = leftTokens.join("");
  const rightCompact = rightTokens.join("");
  if (
    containsAtWordStart(rightTokens, leftCompact) ||
    containsAtWordStart(leftTokens, rightCompact) ||
    nearAtWordStart(rightTokens, leftCompact) ||
    nearAtWordStart(leftTokens, rightCompact)
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
  /** For a transfer bill: payments received on the destination account. */
  toAccountInflows?:
    ReadonlyArray<{ date: string; amount: bigint }> | undefined;
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
/** How long a card or loan payment may take to show on the receiving side. */
const ARRIVAL_WINDOW_MS = 5 * 86_400_000;

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
  payment: BillMatchPayment,
): BillMatchMismatch | null {
  if (payment.isCard && setup.billType === "transfer")
    return "card_on_transfer";
  if (setup.accountId && setup.accountId !== payment.accountId)
    return "account";
  // The card or loan itself shows the payment arriving: whatever the bank
  // called it ("AMEX EPAYMENT"), this is the bill's payee.
  if (
    setup.billType === "transfer" &&
    setup.toAccountInflows?.some(
      (inflow) =>
        inflow.amount === payment.amount &&
        daysApartMs(inflow.date, payment.date) <= ARRIVAL_WINDOW_MS,
    )
  )
    return null;
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
 *
 * `slots` groups interchangeable occurrences: the slot bills of one split
 * series due the same day ("fidelity $50 1/2" and "2/2"). A group takes as
 * many of its closest payments as it has members, counting only payments
 * that qualify for every member, and hands them out in slot order.
 */
export function pairClosest(
  candidates: ReadonlyArray<MatchCandidate>,
  slots: ReadonlyMap<string, { groupId: string; slot: number }> = new Map(),
): Map<string, string> {
  const groupOf = (occurrenceId: string) =>
    slots.get(occurrenceId)?.groupId ?? occurrenceId;
  const members = new Map<string, string[]>();
  for (const occurrenceId of new Set(candidates.map((c) => c.occurrenceId))) {
    const group = groupOf(occurrenceId);
    members.set(group, [...(members.get(group) ?? []), occurrenceId]);
  }
  // A payment qualifies for a group only if it qualifies for every member.
  const perGroup = new Map<
    string,
    Map<string, { count: number; distance: number }>
  >();
  for (const candidate of candidates) {
    const group = groupOf(candidate.occurrenceId);
    const byTransaction = perGroup.get(group) ?? new Map();
    const seen = byTransaction.get(candidate.transactionId);
    byTransaction.set(candidate.transactionId, {
      count: (seen?.count ?? 0) + 1,
      distance: Math.max(seen?.distance ?? 0, candidate.distanceMs),
    });
    perGroup.set(group, byTransaction);
  }
  const groupCandidates = [...perGroup].flatMap(([group, byTransaction]) =>
    [...byTransaction].flatMap(([transactionId, { count, distance }]) =>
      count === members.get(group)!.length
        ? [{ group, transactionId, distance }]
        : [],
    ),
  );
  // Each group's closest payments, as many as it has members; a tie at the
  // cut-off makes the group ambiguous.
  const chosen = new Map<string, string[]>();
  for (const [group, groupMembers] of members) {
    const mine = groupCandidates
      .filter((candidate) => candidate.group === group)
      .sort((a, b) => a.distance - b.distance);
    const capacity = groupMembers.length;
    if (
      mine.length > capacity &&
      mine[capacity - 1]!.distance === mine[capacity]!.distance
    )
      continue;
    chosen.set(
      group,
      mine.slice(0, capacity).map((c) => c.transactionId),
    );
  }
  // Each payment's closest group; a tie leaves it for the user.
  const closestGroup = new Map<
    string,
    { group: string | null; distance: number }
  >();
  for (const candidate of groupCandidates) {
    const current = closestGroup.get(candidate.transactionId);
    if (!current || candidate.distance < current.distance)
      closestGroup.set(candidate.transactionId, {
        group: candidate.group,
        distance: candidate.distance,
      });
    else if (candidate.distance === current.distance)
      closestGroup.set(candidate.transactionId, {
        group: null,
        distance: current.distance,
      });
  }
  const pairs = new Map<string, string>();
  for (const [group, transactionIds] of chosen) {
    const mutual = transactionIds
      .filter((id) => closestGroup.get(id)?.group === group)
      .sort((a, b) => a.localeCompare(b));
    const ordered = [...members.get(group)!].sort(
      (a, b) => (slots.get(a)?.slot ?? 0) - (slots.get(b)?.slot ?? 0),
    );
    ordered.forEach((occurrenceId, index) => {
      if (mutual[index]) pairs.set(occurrenceId, mutual[index]);
    });
  }
  return pairs;
}
