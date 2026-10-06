import { categoryVisibleTo } from "../categories/index.js";
import { accrueInterest } from "./engine/savings-interest.js";
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { normalizeMerchant } from "../bills/recurring-engine.js";
import { withDerivedStatements } from "../accounts/card-statement.js";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import {
  addDays,
  addMonths,
  deriveCycle,
  type AccountsInput,
  type AccountEvent,
  type EngineAccount,
} from "./engine/accounts.js";
import { getForecastEventTagIds } from "./forecast-event-tags.js";
import {
  isUnlinkedManualPayment,
  manualPaymentAmount,
  manualPaymentDate,
  suppressBillForecast,
} from "./bill-occurrence-forecast.js";

type InputDb = Db | DbTransaction;
/** Read-only v2 adapter; v1's input queries deliberately remain untouched. */
export async function getAccountForecastInputs(
  userId: string,
  horizonDays: number,
  today: string,
  db: InputDb = getDb(),
): Promise<Omit<AccountsInput, "today" | "horizonDays">> {
  // A Transactions-only card's statement comes from the user's days.
  const accountRows = await withDerivedStatements(
    db,
    userId,
    await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
          eq(schema.accounts.isHidden, false),
          eq(schema.accounts.excludeFromForecast, false),
          inArray(schema.accounts.type, ["depository", "credit"]),
        ),
      ),
    today,
  );
  const bills = await db
    .select()
    .from(schema.billSetup)
    .where(
      and(
        eq(schema.billSetup.userId, userId),
        isNull(schema.billSetup.deletedAt),
        inArray(schema.billSetup.status, [
          "active",
          "pending_confirmation",
          "paused",
        ]),
      ),
    );
  const txs = await db
    .select({
      id: schema.transactions.id,
      categoryId: schema.transactions.categoryId,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      name: schema.transactions.name,
      merchantName: schema.transactions.merchantName,
      plaidPrimary: schema.transactions.plaidCategoryPrimary,
      userCategoryOverride: schema.transactions.userCategoryOverride,
      currency: schema.transactions.currency,
      status: schema.transactions.status,
      isRecurring: schema.transactions.isRecurring,
      seriesId: schema.transactions.recurringSeriesId,
      exclude: schema.transactions.excludeFromBudgets,
      category: schema.transactions.plaidCategoryDetailed,
      isTransfer: schema.categories.isTransfer,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(
      and(
        eq(schema.transactions.userId, userId),
        isNull(schema.transactions.deletedAt),
        isNull(schema.transactions.parentTransactionId),
        isNull(schema.transactions.isDuplicateOf),
        gte(schema.transactions.date, addDays(today, -180)),
        lte(schema.transactions.date, addDays(today, horizonDays)),
      ),
    );
  const types = new Map(accountRows.map((a) => [a.id, a.type]));
  const isTransfer = (t: (typeof txs)[number]) =>
    t.isTransfer === true ||
    (!t.userCategoryOverride &&
      (t.plaidPrimary === "TRANSFER_IN" || t.plaidPrimary === "TRANSFER_OUT"));
  const recurringKeys = new Set(
    bills
      .filter((b) => b.billType === "payable")
      .flatMap((b) =>
        [b.canonicalName, ...b.merchantPatterns]
          .map(normalizeMerchant)
          .filter(Boolean)
          .map((name) => `${name}:${b.isIncome}`),
      )
      .filter(Boolean),
  );
  const isRecurring = (t: (typeof txs)[number]) =>
    t.isRecurring ||
    !!t.seriesId ||
    recurringKeys.has(
      `${normalizeMerchant(t.merchantName ?? t.name)}:${t.amount < 0n}`,
    );
  const cashOutflows = txs.filter(
    (t) => types.get(t.accountId) === "depository" && t.amount > 0n,
  );
  const paymentIds = new Set<string>();
  for (const t of txs) {
    if (t.category === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT")
      paymentIds.add(t.id);
    if (types.get(t.accountId) !== "credit" || t.amount >= 0n) continue;
    const matches = cashOutflows.filter(
      (out) =>
        out.currency === t.currency &&
        out.amount + t.amount >= -100n &&
        out.amount + t.amount <= 100n &&
        Math.abs(Date.parse(out.date) - Date.parse(t.date)) <= 3 * 86_400_000,
    );
    if (matches.length) {
      paymentIds.add(t.id);
      for (const match of matches) paymentIds.add(match.id);
    }
  }
  const occurrences = await db
    .select()
    .from(schema.billOccurrences)
    .where(eq(schema.billOccurrences.userId, userId));
  const manualOccurrences = occurrences.filter(isUnlinkedManualPayment);
  const manualOccurrenceIds = manualOccurrences.map((row) => row.id);
  const occurrencesById = new Map(occurrences.map((row) => [row.id, row]));
  const accounts: EngineAccount[] = accountRows.map((a) => {
    const result: EngineAccount = {
      id: a.id,
      name: a.name,
      kind: a.type === "credit" ? "card" : "cash",
      startingBalanceCents: a.currentBalance ?? 0n,
    };
    if (a.type !== "credit") {
      const apy = a.apyOverride ?? a.apy;
      if (
        (a.subtypeOverride ?? a.subtype) === "savings" &&
        apy !== null &&
        apy > 0 &&
        a.currentBalance !== null
      ) {
        const posted = txs.filter(
          (t) =>
            t.accountId === a.id && t.status === "posted" && t.date <= today,
        );
        const deposits = posted.filter(
          (t) => t.amount < 0n && t.category === "INCOME_INTEREST_EARNED",
        );
        const latest = deposits
          .map((t) => t.date)
          .sort()
          .at(-1);
        const days = deposits
          .map((t) => Number(t.date.slice(8)))
          .sort((a, b) => a - b);
        const allMonthEnds = deposits.every(
          (t) => t.date === addDays(`${addDays(t.date, 1).slice(0, 7)}-01`, -1),
        );
        const creditDay =
          days.length >= 3 && !allMonthEnds && days.at(-1)! - days[0]! <= 5
            ? days[Math.floor(days.length / 2)]!
            : 31;
        const thisClose = addMonths(today, 0, creditDay);
        const cycleStart = addDays(
          addMonths(thisClose, today <= thisClose ? -1 : 0, creditDay),
          1,
        );
        const earliest = posted.map((t) => t.date).sort()[0] ?? today;
        const start = [cycleStart, latest ? addDays(latest, 1) : earliest]
          .sort()
          .at(-1)!;
        let accrued = 0n;
        for (let date = start; date < today; date = addDays(date, 1)) {
          const balance =
            a.currentBalance! +
            posted
              .filter((t) => t.date > date)
              .reduce((sum, t) => sum + t.amount, 0n);
          accrued = accrueInterest(balance, accrued, apy, date);
        }
        result.savingsInterest = {
          apy,
          accruedScaledCents: accrued,
          creditDay,
          creditedMonths: [...new Set(deposits.map((t) => t.date.slice(0, 7)))],
        };
      }
      return result;
    }
    const bill = bills.find(
      (b) => b.billType === "transfer" && b.toAccountId === a.id,
    );
    const manualCardPayments = manualOccurrences
      .filter(
        (row) =>
          row.billSetupId === bill?.id &&
          manualPaymentDate(row, today) <= addDays(today, horizonDays - 1),
      )
      .sort((a, b) =>
        manualPaymentDate(a, today).localeCompare(manualPaymentDate(b, today)),
      );
    const paymentDates = txs
      .filter(
        (t) =>
          t.accountId === a.id &&
          t.amount < 0n &&
          t.status === "posted" &&
          t.date <= today &&
          paymentIds.has(t.id),
      )
      .map((t) => t.date);
    const derived = deriveCycle(
      {
        statementDate: a.statementDate,
        paymentDueDate: a.paymentDueDateOverride ?? a.paymentDueDate,
        paymentDates,
      },
      today,
    );
    const evidenceClose = a.statementDate ?? derived?.close ?? today;
    const since = txs.filter(
      (t) =>
        t.accountId === a.id &&
        t.status === "posted" &&
        t.date <= today &&
        t.date > evidenceClose,
    );
    const paid = since
      .filter((t) => t.amount < 0n && paymentIds.has(t.id))
      .reduce((sum, t) => sum - t.amount, 0n);
    const credits = derived
      ? since
          .filter(
            (t) =>
              t.amount < 0n &&
              !paymentIds.has(t.id) &&
              (!(a.paymentDueDateOverride ?? a.paymentDueDate) ||
                t.date <= (a.paymentDueDateOverride ?? a.paymentDueDate)!),
          )
          .reduce((sum, t) => sum - t.amount, 0n)
      : 0n;
    const original = a.statementBalance ?? 0n;
    const billed = original > paid ? original - paid : 0n;
    const override =
      occurrences.find(
        (o) =>
          o.billSetupId === bill?.id &&
          o.dueDate === (a.paymentDueDateOverride ?? a.paymentDueDate) &&
          o.paymentOverrideCents !== null &&
          ["upcoming", "overdue"].includes(o.status),
      )?.paymentOverrideCents ?? null;
    result.card = {
      billedCents: billed,
      unbilledCents: (a.currentBalance ?? 0n) - billed + credits,
      creditsSinceCloseCents: credits,
      statementDate: a.statementDate,
      paymentDueDate: a.paymentDueDateOverride ?? a.paymentDueDate,
      minimumPaymentCents: a.minimumPayment,
      lastPaymentCents: a.lastPaymentCents,
      rule:
        a.cardPaymentRule === "planned"
          ? { kind: "planned", amountCents: a.cardPlannedPaymentCents ?? 0n }
          : { kind: a.cardPaymentRule },
      statementPaymentOverrideCents: override,
      payFromAccountId: bill?.accountId ?? null,
      paidFromExternal:
        (bill?.paidFromExternal ?? false) ||
        (!!bill?.accountId && !types.has(bill.accountId)),
      paymentsSinceCloseCents: paid,
      originalBilledCents: original,
      paymentDates: txs
        .filter(
          (t) =>
            t.accountId === a.id &&
            t.amount < 0n &&
            t.status === "posted" &&
            t.date <= today &&
            paymentIds.has(t.id),
        )
        .map((t) => t.date),
      ...(manualCardPayments.length && bill
        ? {
            manualPayments: manualCardPayments.map((occurrence) => ({
              date: manualPaymentDate(occurrence, today),
              amountCents: manualPaymentAmount(occurrence),
              payFromAccountId: occurrence.paidAccountId ?? bill.accountId,
              name: bill.displayName ?? bill.canonicalName,
              recurringSeriesId: bill.id,
              categoryId: bill.categoryId,
            })),
          }
        : {}),
    };
    return result;
  });
  const rawEvents = await db
    .select()
    .from(schema.forecastEvents)
    .where(
      and(
        eq(schema.forecastEvents.userId, userId),
        isNull(schema.forecastEvents.deletedAt),
        isNull(schema.forecastEvents.resolvedToTransactionId),
        or(
          gte(schema.forecastEvents.date, today),
          manualOccurrenceIds.length
            ? inArray(
                schema.forecastEvents.billOccurrenceId,
                manualOccurrenceIds,
              )
            : undefined,
        ),
        lte(schema.forecastEvents.date, addDays(today, horizonDays)),
      ),
    );
  const eventCategoryIds = [
    ...new Set(rawEvents.flatMap((e) => (e.categoryId ? [e.categoryId] : []))),
  ];
  const eventCategories = eventCategoryIds.length
    ? await db
        .select({ id: schema.categories.id, name: schema.categories.name })
        .from(schema.categories)
        .where(
          and(
            inArray(schema.categories.id, eventCategoryIds),
            categoryVisibleTo(userId),
          ),
        )
    : [];
  const interestCategories = new Set(
    eventCategories
      .filter((c) => c.name.toLowerCase().includes("interest"))
      .map((c) => c.id),
  );
  const occurrenceForEvent = (e: (typeof rawEvents)[number]) =>
    e.billOccurrenceId
      ? occurrencesById.get(e.billOccurrenceId)
      : occurrences.find(
          (row) =>
            row.billSetupId === e.recurringSeriesId &&
            (row.dueDateOverride ?? row.dueDate) === e.date,
        );
  const representedOccurrences = new Set(
    rawEvents.flatMap((event) => {
      const occurrence = occurrenceForEvent(event);
      return occurrence ? [occurrence.id] : [];
    }),
  );
  const events: AccountEvent[] = rawEvents.flatMap((e) => {
    const bill = bills.find((b) => b.id === e.recurringSeriesId);
    const occurrence = occurrenceForEvent(e);
    if (occurrence && suppressBillForecast(occurrence)) return [];
    const manual = occurrence && isUnlinkedManualPayment(occurrence);
    // Card bills supply route/override data only; the engine emits their payment once.
    if (
      bill?.billType === "transfer" &&
      types.get(bill.toAccountId ?? "") === "credit"
    )
      return [];
    const accountId = manual
      ? (occurrence.paidAccountId ?? bill?.accountId ?? e.accountId)
      : (bill?.accountId ?? e.accountId);
    if (accountId && !types.has(accountId)) return [];
    return [
      {
        date: manual ? manualPaymentDate(occurrence, today) : e.date,
        amountCents: manual ? manualPaymentAmount(occurrence) : e.amount,
        name: e.name,
        confidence: 0.9,
        sourceType: e.sourceType === "recurring" ? "recurring" : "manual",
        sourceId: e.id,
        recurringSeriesId: e.recurringSeriesId,
        categoryId: e.categoryId,
        tagIds: [],
        accountId,
        interestDeposit:
          e.amount < 0n &&
          e.categoryId !== null &&
          interestCategories.has(e.categoryId),
        paidFromExternal:
          manual && accountId
            ? false
            : (bill?.paidFromExternal ?? false) ||
              (!!bill?.accountId && !types.has(bill.accountId)),
        cardCredit: e.amount < 0n && types.get(accountId ?? "") === "credit",
      },
    ];
  });
  for (const occurrence of manualOccurrences) {
    if (representedOccurrences.has(occurrence.id)) continue;
    const date = manualPaymentDate(occurrence, today);
    if (date > addDays(today, horizonDays - 1)) continue;
    const bill = bills.find((row) => row.id === occurrence.billSetupId);
    if (!bill) continue;
    if (
      bill.billType === "transfer" &&
      types.get(bill.toAccountId ?? "") === "credit"
    )
      continue;
    const accountId = occurrence.paidAccountId ?? bill.accountId;
    if (accountId && !types.has(accountId)) continue;
    events.push({
      date,
      amountCents: manualPaymentAmount(occurrence),
      name: bill.displayName ?? bill.canonicalName,
      confidence: 0.9,
      sourceType: "recurring",
      recurringSeriesId: bill.id,
      categoryId: bill.categoryId,
      tagIds: [],
      accountId,
      cardCredit: false,
      paidFromExternal: accountId ? false : bill.paidFromExternal,
    });
  }
  const pendingEvents = txs.filter(
    (t) =>
      t.status === "pending" &&
      !isRecurring(t) &&
      t.date >= today &&
      types.has(t.accountId) &&
      !paymentIds.has(t.id) &&
      !isTransfer(t),
  );
  const pendingTagIds = await getForecastEventTagIds(
    db,
    userId,
    pendingEvents.map((transaction) => transaction.id),
  );
  for (const t of pendingEvents) {
    events.push({
      date: t.date,
      name: t.name,
      amountCents: t.amount,
      confidence: 0.7,
      sourceType: "pending_transaction",
      sourceId: t.id,
      categoryId: t.categoryId,
      tagIds: pendingTagIds.get(t.id) ?? [],
      accountId: t.accountId,
      cardCredit: t.amount < 0n && types.get(t.accountId) === "credit",
      interestDeposit: t.amount < 0n && t.category === "INCOME_INTEREST_EARNED",
    });
  }
  const dailySpendByAccount = new Map<string, bigint>();
  for (const a of accountRows) {
    const history = txs.filter(
      (t) =>
        t.accountId === a.id &&
        t.status === "posted" &&
        t.date <= today &&
        t.date >= addDays(today, -90),
    );
    const total = history
      .filter(
        (t) =>
          t.amount > 0n &&
          !isRecurring(t) &&
          !t.exclude &&
          !isTransfer(t) &&
          !paymentIds.has(t.id),
      )
      .reduce((sum, t) => sum + t.amount, 0n);
    const accountHistory = txs.filter(
      (t) => t.accountId === a.id && t.status === "posted" && t.date <= today,
    );
    const earliest = accountHistory.reduce(
      (date, t) => (t.date < date ? t.date : date),
      today,
    );
    const days = Math.min(
      90,
      Math.max(
        1,
        Math.round((Date.parse(today) - Date.parse(earliest)) / 86_400_000) + 1,
      ),
    );
    dailySpendByAccount.set(a.id, total / BigInt(days));
  }
  const active = bills.filter(
    (b) => b.status === "active" && !b.accountId && !b.paidFromExternal,
  );
  return {
    accounts,
    events,
    dailySpendByAccount,
    unassignedBillCount: active.length,
  };
}
