import {
  and,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { logger } from "../../platform/logging/logger.js";
import type { ForecastInputEvent, ForecastResult } from "./engine/types.js";

type ForecastDb = Db | DbTransaction;

export type ForecastInputs = Readonly<{
  startingBalanceCents: bigint;
  events: ForecastInputEvent[];
  discretionaryDailyAvgCents: bigint;
}>;

export type ForecastRepository = Readonly<{
  getForecastInputs: (
    userId: string,
    horizonDays: number,
    today?: string,
  ) => Promise<ForecastInputs>;
  saveForecastRun: (
    userId: string,
    result: ForecastResult,
    horizonDays: number,
    startBalanceCents: bigint,
  ) => Promise<string>;
  getAccuracySummary: (
    userId: string,
  ) => Promise<{ mape30d: number | null; runCount: number }>;
  computeAndSaveAccuracyBatch: () => Promise<number>;
  isFeatureEnabled: (flagKey: string, userId: string) => Promise<boolean>;
}>;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function getForecastInputs(
  db: ForecastDb,
  userId: string,
  horizonDays: number,
  today = todayUtc(),
): Promise<ForecastInputs> {
  const endDate = addDays(today, horizonDays);
  const [liquidRows, eventRows, pendingTransactions, discretionaryRows] =
    await Promise.all([
      db
        .select({
          total: sql<string>`COALESCE(SUM(${schema.accounts.currentBalance}), 0)`,
        })
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.type, "depository"),
            eq(schema.accounts.excludeFromForecast, false),
            eq(schema.accounts.isHidden, false),
            isNull(schema.accounts.deletedAt),
          ),
        ),
      db
        .select({
          id: schema.forecastEvents.id,
          date: schema.forecastEvents.date,
          amount: schema.forecastEvents.amount,
          name: schema.forecastEvents.name,
          sourceType: schema.forecastEvents.sourceType,
          recurringSeriesId: schema.forecastEvents.recurringSeriesId,
        })
        .from(schema.forecastEvents)
        .leftJoin(
          schema.billOccurrences,
          and(
            eq(
              schema.forecastEvents.recurringSeriesId,
              schema.billOccurrences.billSetupId,
            ),
            eq(schema.forecastEvents.date, schema.billOccurrences.dueDate),
          ),
        )
        .where(
          and(
            eq(schema.forecastEvents.userId, userId),
            isNull(schema.forecastEvents.deletedAt),
            isNull(schema.forecastEvents.resolvedToTransactionId),
            gte(schema.forecastEvents.date, today),
            lte(schema.forecastEvents.date, endDate),
            or(
              isNull(schema.billOccurrences.status),
              notInArray(schema.billOccurrences.status, [
                "processing",
                "paid",
                "skipped",
                "cancelled",
              ]),
            ),
          ),
        ),
      db
        .select({
          id: schema.transactions.id,
          name: schema.transactions.name,
          amount: schema.transactions.amount,
          date: schema.transactions.date,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.status, "pending"),
            eq(schema.transactions.isRecurring, false),
            isNull(schema.transactions.deletedAt),
            gte(schema.transactions.date, today),
            lte(schema.transactions.date, endDate),
          ),
        ),
      db
        .select({
          total: sql<string>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.status, "posted"),
            eq(schema.transactions.isRecurring, false),
            eq(schema.transactions.excludeFromBudgets, false),
            isNull(schema.transactions.deletedAt),
            sql`${schema.transactions.date} >= CURRENT_DATE - INTERVAL '90 days'`,
            gt(schema.transactions.amount, 0n),
          ),
        ),
    ]);

  const events: ForecastInputEvent[] = [
    ...eventRows.map((event) => ({
      date: event.date,
      amountCents: event.amount,
      name: event.name,
      confidence: 0.9,
      sourceType: (event.sourceType === "recurring"
        ? "recurring"
        : "manual") as "recurring" | "manual",
      sourceId: event.id,
      recurringSeriesId: event.recurringSeriesId ?? null,
    })),
    ...pendingTransactions.map((transaction) => ({
      date: transaction.date,
      amountCents: transaction.amount,
      name: transaction.name,
      confidence: 0.7,
      sourceType: "pending_transaction" as const,
      sourceId: transaction.id,
    })),
  ];
  return {
    startingBalanceCents: BigInt(liquidRows[0]?.total ?? "0"),
    events,
    discretionaryDailyAvgCents:
      BigInt(discretionaryRows[0]?.total ?? "0") / 90n,
  };
}

async function saveForecastRun(
  db: ForecastDb,
  userId: string,
  result: ForecastResult,
  horizonDays: number,
  startBalanceCents: bigint,
): Promise<string> {
  const rows = await db
    .insert(schema.forecastRuns)
    .values({
      userId,
      horizonDays,
      algorithmVersion: result.algorithmVersion,
      startBalance: startBalanceCents,
      endBalanceP50: result.days.at(-1)?.p50Cents ?? 0n,
      minBalanceP10: result.tightestDay.balanceCents,
      minBalanceDate: result.tightestDay.date,
      dailyResults: result.days.map((day) => ({
        date: day.date,
        p10: day.p10Cents.toString(),
        p50: day.p50Cents.toString(),
        p90: day.p90Cents.toString(),
        events: day.events.map((event) => ({
          name: event.name,
          amount: event.amountCents.toString(),
          confidence: event.confidence,
          sourceType: event.sourceType,
          ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }),
        })),
      })),
    })
    .returning({ id: schema.forecastRuns.id });
  const row = rows[0];
  if (!row) throw new Error("Forecast run insert did not return a row");
  return row.id;
}

async function getAccuracySummary(
  db: ForecastDb,
  userId: string,
): Promise<{ mape30d: number | null; runCount: number }> {
  const rows = await db
    .select({ mape: schema.forecastRuns.mape })
    .from(schema.forecastRuns)
    .where(
      and(
        eq(schema.forecastRuns.userId, userId),
        isNotNull(schema.forecastRuns.mape),
        gte(schema.forecastRuns.createdAt, sql`NOW() - INTERVAL '30 days'`),
      ),
    );
  if (rows.length < 3) return { mape30d: null, runCount: rows.length };
  return {
    mape30d: rows.reduce((sum, row) => sum + (row.mape ?? 0), 0) / rows.length,
    runCount: rows.length,
  };
}

async function computeAndSaveAccuracyBatch(db: ForecastDb): Promise<number> {
  const runs = await db
    .select()
    .from(schema.forecastRuns)
    .where(
      and(
        isNull(schema.forecastRuns.mape),
        sql`${schema.forecastRuns.createdAt}::date + ${schema.forecastRuns.horizonDays} * INTERVAL '1 day' <= CURRENT_DATE`,
      ),
    )
    .limit(20);
  let updated = 0;
  for (const run of runs) {
    try {
      const startDate = run.createdAt.toISOString().slice(0, 10);
      const endDate = addDays(startDate, run.horizonDays);
      const transactions = await db
        .select({
          date: schema.transactions.date,
          amount: schema.transactions.amount,
        })
        .from(schema.transactions)
        .innerJoin(
          schema.accounts,
          eq(schema.transactions.accountId, schema.accounts.id),
        )
        .where(
          and(
            eq(schema.transactions.userId, run.userId),
            eq(schema.transactions.status, "posted"),
            isNull(schema.transactions.deletedAt),
            eq(schema.accounts.type, "depository"),
            eq(schema.accounts.isHidden, false),
            isNull(schema.accounts.deletedAt),
            gte(schema.transactions.date, startDate),
            lte(schema.transactions.date, endDate),
          ),
        );
      const byDate = new Map<string, bigint>();
      for (const transaction of transactions)
        byDate.set(
          transaction.date,
          (byDate.get(transaction.date) ?? 0n) + transaction.amount,
        );
      const dailyResults = run.dailyResults as Array<{
        date: string;
        p50: string;
      }>;
      let runningBalance = run.startBalance;
      const actualByDate = new Map<string, bigint>();
      for (const daily of dailyResults) {
        runningBalance -= byDate.get(daily.date) ?? 0n;
        actualByDate.set(daily.date, runningBalance);
      }
      let sumRelativeError = 0;
      let count = 0;
      for (const daily of dailyResults) {
        const actual = actualByDate.get(daily.date);
        if (actual === undefined) continue;
        const denominator = Math.max(Math.abs(Number(actual)), 1);
        sumRelativeError +=
          Math.abs(Number(BigInt(daily.p50)) - Number(actual)) / denominator;
        count += 1;
      }
      if (count === 0) continue;
      const last = dailyResults.at(-1);
      await db
        .update(schema.forecastRuns)
        .set({
          mape: sumRelativeError / count,
          actualEndBalance: last
            ? (actualByDate.get(last.date) ?? run.startBalance)
            : run.startBalance,
        })
        .where(eq(schema.forecastRuns.id, run.id));
      updated += 1;
    } catch (error: unknown) {
      // Accuracy is a best-effort worker batch; a later run retries this row.
      logger.error({ error, runId: run.id }, "computeAndSaveAccuracy failed");
    }
  }
  return updated;
}

async function isFeatureEnabled(
  db: ForecastDb,
  flagKey: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({
      userId: schema.featureFlags.userId,
      enabled: schema.featureFlags.enabled,
    })
    .from(schema.featureFlags)
    .where(
      and(
        eq(schema.featureFlags.flagKey, flagKey),
        or(
          eq(schema.featureFlags.userId, userId),
          isNull(schema.featureFlags.userId),
        ),
      ),
    );
  // A missing flag is fail-open; when both scopes exist, both must be enabled.
  return rows.length === 0 || rows.every((row) => row.enabled);
}

export const forecastRepository: ForecastRepository = {
  getForecastInputs: (userId, horizonDays, today) =>
    getForecastInputs(getDb(), userId, horizonDays, today),
  saveForecastRun: (userId, result, horizonDays, startBalanceCents) =>
    saveForecastRun(getDb(), userId, result, horizonDays, startBalanceCents),
  getAccuracySummary: (userId) => getAccuracySummary(getDb(), userId),
  computeAndSaveAccuracyBatch: () => computeAndSaveAccuracyBatch(getDb()),
  isFeatureEnabled: (flagKey, userId) =>
    isFeatureEnabled(getDb(), flagKey, userId),
};

/** Binds Forecast reads/writes to an explicit isolated test database client. */
export function createForecastRepository(db: Db): ForecastRepository {
  return {
    getForecastInputs: (userId, horizonDays, today) =>
      getForecastInputs(db, userId, horizonDays, today),
    saveForecastRun: (userId, result, horizonDays, startBalanceCents) =>
      saveForecastRun(db, userId, result, horizonDays, startBalanceCents),
    getAccuracySummary: (userId) => getAccuracySummary(db, userId),
    computeAndSaveAccuracyBatch: () => computeAndSaveAccuracyBatch(db),
    isFeatureEnabled: (flagKey, userId) =>
      isFeatureEnabled(db, flagKey, userId),
  };
}
