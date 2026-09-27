import type { ForecastInputEvent, ForecastResult } from "./types.js";
export const UNASSIGNED_CASH = "unassigned-cash";
export type CardRule =
  | { kind: "full" }
  | { kind: "planned"; amountCents: bigint }
  | { kind: "interest_saving" };
export type EngineCard = {
  billedCents: bigint;
  unbilledCents: bigint;
  creditsSinceCloseCents: bigint;
  statementDate: string | null;
  paymentDueDate: string | null;
  minimumPaymentCents: bigint | null;
  lastPaymentCents: bigint | null;
  rule: CardRule;
  statementPaymentOverrideCents: bigint | null;
  payFromAccountId: string | null;
  paidFromExternal?: boolean;
  paymentsSinceCloseCents?: bigint;
  originalBilledCents?: bigint;
  paymentDates?: string[];
};
export type EngineAccount = {
  id: string;
  name: string;
  kind: "cash" | "card";
  startingBalanceCents: bigint;
  card?: EngineCard;
};
export type AccountEvent = ForecastInputEvent & {
  accountId: string | null;
  cardPayment?: boolean;
  cardCredit?: boolean;
  paidFromExternal?: boolean;
};
export type AccountsInput = {
  today: string;
  horizonDays: number;
  accounts: EngineAccount[];
  events: AccountEvent[];
  dailySpendByAccount: ReadonlyMap<string, bigint>;
  unassignedBillCount: number;
};
export type CardStatement = {
  accountId: string;
  closeDate: string;
  amountCents: bigint;
  dueDate: string;
  paymentCents: bigint;
  rule: CardRule["kind"];
  payFromAccountId: string | null;
  estimated: boolean;
  cycleEstimated: boolean;
  mismatch: string | null;
  overdue: boolean;
};
export type AccountsResult = ForecastResult & {
  accounts: Array<{
    id: string;
    name: string;
    kind: "cash" | "card";
    balances: bigint[];
  }>;
  cashWarnings: Array<{
    accountId: string;
    firstNegativeDate: string;
    lowestCents: bigint;
    lowestDate: string;
  }>;
  cardStatements: CardStatement[];
  unassignedBillCount: number;
};
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function addMonths(
  date: string,
  months: number,
  anchorDay = Number(date.slice(8)),
): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(anchorDay, last));
  return d.toISOString().slice(0, 10);
}
/** The only payment-rule calculation; integer cents, floor then owed cap. */
export function cardPaymentFor(card: EngineCard): {
  amountCents: bigint;
  estimated: boolean;
} {
  const owed = max(0n, card.billedCents - card.creditsSinceCloseCents);
  const estimated =
    card.rule.kind === "interest_saving" &&
    card.statementPaymentOverrideCents === null;
  const requested =
    card.rule.kind === "full"
      ? owed
      : card.rule.kind === "planned"
        ? card.rule.amountCents
        : (card.statementPaymentOverrideCents ??
          max(card.minimumPaymentCents ?? 0n, card.lastPaymentCents ?? 0n));
  return {
    amountCents: min(
      owed,
      max(0n, max(requested, card.minimumPaymentCents ?? 0n)),
    ),
    estimated,
  };
}
export function deriveCycle(
  card: Pick<EngineCard, "statementDate" | "paymentDueDate" | "paymentDates">,
  today: string,
): { close: string; offset: number; estimated: boolean } | null {
  if (card.statementDate) {
    const offset = card.paymentDueDate
      ? Math.round(
          (Date.parse(card.paymentDueDate) - Date.parse(card.statementDate)) /
            86_400_000,
        )
      : 25;
    return {
      close: card.statementDate,
      offset: offset > 0 && offset <= 60 ? offset : 25,
      estimated: !card.paymentDueDate,
    };
  }
  if (!card.paymentDueDate) return null;
  let due = card.paymentDueDate;
  const days = (card.paymentDates ?? [])
    .map((d) => Number(d.slice(8)))
    .sort((a, b) => a - b);
  if (days.length >= 3 && days.at(-1)! - days[0]! <= 5) {
    const median = days[Math.floor(days.length / 2)]!;
    due = addMonths(`${due.slice(0, 7)}-01`, 0, median);
    while (due < today) due = addMonths(due, 1, median);
  }
  return { close: addDays(due, -25), offset: 25, estimated: true };
}
/** Per-account projection. Card payment occurrences are never replayed as input cash events. */
export function generateAccountsForecast(input: AccountsInput): AccountsResult {
  if (input.horizonDays <= 0) throw Error("horizonDays must be positive");
  if (input.accounts.some((a) => a.kind === "card" && !a.card))
    throw new Error("Card accounts require debt state.");
  const output = input.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    balances: [] as bigint[],
  }));
  const cash = new Map(
    input.accounts
      .filter((a) => a.kind === "cash")
      .map((a) => [a.id, a.startingBalanceCents]),
  );
  cash.set(UNASSIGNED_CASH, 0n);
  const cards = input.accounts
    .filter((a) => a.kind === "card" && a.card)
    .map((a) => {
      const card = { ...a.card! };
      const cycle = deriveCycle(card, input.today);
      let nextClose = cycle ? addMonths(cycle.close, 1) : null;
      const anchor = cycle ? Number(cycle.close.slice(8)) : 1;
      while (nextClose && nextClose < input.today)
        nextClose = addMonths(nextClose, 1, anchor);
      let due = card.paymentDueDate;
      let overdue = false;
      if (due && due < input.today) {
        const required = cardPaymentFor({
          ...card,
          billedCents: card.originalBilledCents ?? card.billedCents,
        }).amountCents;
        if ((card.paymentsSinceCloseCents ?? 0n) >= required) due = null;
        else {
          due = input.today;
          overdue = true;
        }
      }
      return {
        account: a,
        card,
        cycle,
        nextClose,
        anchor,
        due,
        overdue,
        statementIndex: -1,
        deferred: [] as Array<{
          card: EngineCard;
          due: string;
          statementIndex: number;
        }>,
      };
    });
  const statements: CardStatement[] = [];
  const makeStatement = (
    state: (typeof cards)[number],
    close: string,
    due: string,
  ) => {
    const payment = cardPaymentFor(state.card);
    const planned =
      state.card.rule.kind === "planned" ? state.card.rule.amountCents : null;
    const mismatch =
      planned !== null &&
      state.card.lastPaymentCents !== null &&
      max(
        planned - state.card.lastPaymentCents,
        state.card.lastPaymentCents - planned,
      ) *
        10n >
        max(1n, planned)
        ? "Last payment differs from the planned amount by more than 10%."
        : null;
    statements.push({
      accountId: state.account.id,
      closeDate: close,
      amountCents: max(
        0n,
        state.card.billedCents - state.card.creditsSinceCloseCents,
      ),
      dueDate: due,
      paymentCents: payment.amountCents,
      rule: state.card.rule.kind,
      payFromAccountId: state.card.paidFromExternal
        ? null
        : state.card.payFromAccountId,
      estimated: payment.estimated,
      cycleEstimated: state.cycle?.estimated ?? true,
      mismatch,
      overdue: state.overdue,
    });
    state.statementIndex = statements.length - 1;
  };
  for (const state of cards)
    if (state.due)
      makeStatement(state, state.cycle?.close ?? input.today, state.due);
  const grouped = new Map<string, AccountEvent[]>();
  for (const event of input.events) {
    if (event.cardPayment) continue;
    const list = grouped.get(event.date) ?? [];
    list.push(event);
    grouped.set(event.date, list);
  }
  const days: AccountsResult["days"] = [];
  const warnings = new Map<string, AccountsResult["cashWarnings"][number]>();
  for (let offset = 0; offset < input.horizonDays; offset++) {
    const date = addDays(input.today, offset);
    const events = [...(grouped.get(date) ?? [])];
    for (const event of events) {
      if (event.paidFromExternal) continue;
      const card = cards.find((s) => s.account.id === event.accountId);
      if (card) {
        if (
          event.amountCents < 0n &&
          event.cardCredit &&
          card.due &&
          date <=
            (card.deferred[0]?.due ??
              (card.overdue
                ? (card.card.paymentDueDate ?? card.due)
                : card.due))
        )
          (card.deferred[0]?.card ?? card.card).creditsSinceCloseCents -=
            event.amountCents;
        else card.card.unbilledCents += event.amountCents;
      } else {
        const id =
          event.accountId && cash.has(event.accountId)
            ? event.accountId
            : UNASSIGNED_CASH;
        cash.set(id, cash.get(id)! - event.amountCents);
      }
    }
    for (const [id, amount] of input.dailySpendByAccount) {
      const card = cards.find((s) => s.account.id === id);
      if (card) card.card.unbilledCents += amount;
      else if (cash.has(id)) cash.set(id, cash.get(id)! - amount);
    }
    const pay = (state: (typeof cards)[number]) => {
      const payment = cardPaymentFor(state.card);
      const statement = statements[state.statementIndex];
      if (statement) {
        statement.paymentCents = payment.amountCents;
        statement.amountCents = max(
          0n,
          state.card.billedCents - state.card.creditsSinceCloseCents,
        );
      }
      state.card.unbilledCents -= max(
        0n,
        state.card.creditsSinceCloseCents - state.card.billedCents,
      );
      state.card.billedCents = max(
        0n,
        state.card.billedCents -
          state.card.creditsSinceCloseCents -
          payment.amountCents,
      );
      state.card.creditsSinceCloseCents = 0n;
      const source =
        state.card.payFromAccountId && cash.has(state.card.payFromAccountId)
          ? state.card.payFromAccountId
          : UNASSIGNED_CASH;
      if (!state.card.paidFromExternal) {
        cash.set(source, cash.get(source)! - payment.amountCents);
        events.push({
          date,
          name: `${state.account.name} payment`,
          amountCents: payment.amountCents,
          confidence: payment.estimated ? 0.7 : 0.9,
          sourceType: "card_payment",
          accountId: source,
        });
      }
      events.push({
        date,
        name: `${state.account.name} payment`,
        amountCents: -payment.amountCents,
        confidence: payment.estimated ? 0.7 : 0.9,
        sourceType: "card_payment",
        accountId: state.account.id,
      });
      state.due = null;
      state.overdue = false;
    };
    for (const state of cards) {
      // Preserve an overdue old statement when its catch-up payment shares a close date.
      if (state.overdue && state.due === date) pay(state);
      for (const deferred of [...state.deferred]) {
        if (deferred.due !== date) continue;
        const deferredState = {
          ...state,
          card: deferred.card,
          due: deferred.due,
          statementIndex: deferred.statementIndex,
        };
        pay(deferredState);
        state.card.billedCents += deferredState.card.billedCents;
        state.card.unbilledCents += deferredState.card.unbilledCents;
        state.deferred = state.deferred.filter((item) => item !== deferred);
      }
      if (state.nextClose === date) {
        if (state.due && state.due > date) {
          state.deferred.push({
            card: { ...state.card, unbilledCents: 0n },
            due: state.due,
            statementIndex: state.statementIndex,
          });
          state.card.billedCents = 0n;
          state.card.creditsSinceCloseCents = 0n;
        }
        const closingBalance =
          state.card.billedCents + state.card.unbilledCents;
        state.card.billedCents = max(0n, closingBalance);
        state.card.unbilledCents = min(0n, closingBalance);
        state.card.statementPaymentOverrideCents = null;
        state.due = addDays(date, state.cycle!.offset);
        makeStatement(state, date, state.due);
        state.nextClose = addMonths(date, 1, state.anchor);
      }
      if (state.due === date) pay(state);
    }
    const total = [...cash.values()].reduce((a, b) => a + b, 0n);
    days.push({
      date,
      p50Cents: total,
      p10Cents: total,
      p90Cents: total,
      events,
    });
    for (const account of output) {
      const card = cards.find((s) => s.account.id === account.id);
      account.balances.push(
        card
          ? card.card.billedCents +
              card.card.unbilledCents -
              card.card.creditsSinceCloseCents +
              card.deferred.reduce(
                (sum, c) =>
                  sum + c.card.billedCents - c.card.creditsSinceCloseCents,
                0n,
              )
          : (cash.get(account.id) ?? 0n),
      );
    }
    for (const [id, balance] of cash) {
      if (id === UNASSIGNED_CASH || balance >= 0n) continue;
      const warning = warnings.get(id);
      if (!warning)
        warnings.set(id, {
          accountId: id,
          firstNegativeDate: date,
          lowestCents: balance,
          lowestDate: date,
        });
      else if (balance < warning.lowestCents) {
        warning.lowestCents = balance;
        warning.lowestDate = date;
      }
    }
  }
  if (
    input.events.some(
      (event) => event.accountId === null && !event.paidFromExternal,
    ) ||
    days.some((d) =>
      d.events.some((e) => "accountId" in e && e.accountId === UNASSIGNED_CASH),
    ) ||
    cash.get(UNASSIGNED_CASH) !== 0n
  ) {
    const balances = days.map(
      (day, i) =>
        day.p50Cents -
        output
          .filter((a) => a.kind === "cash")
          .reduce((sum, a) => sum + a.balances[i]!, 0n),
    );
    output.push({
      id: UNASSIGNED_CASH,
      name: "Unassigned cash",
      kind: "cash",
      balances,
    });
  }
  const tightest = days.reduce(
    (a, b) => (b.p50Cents < a.p50Cents ? b : a),
    days[0]!,
  );
  return {
    days,
    tightestDay: { date: tightest.date, balanceCents: tightest.p50Cents },
    algorithmVersion: "v2",
    accounts: output,
    cashWarnings: [...warnings.values()],
    cardStatements: statements,
    unassignedBillCount: input.unassignedBillCount,
  };
}
