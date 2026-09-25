import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

type ForecastEventsDb = Db | DbTransaction;
export type ForecastEventRow = typeof schema.forecastEvents.$inferSelect;
export type NewForecastEvent = Readonly<{
  userId: string;
  accountId?: string | null;
  name: string;
  amountCents: bigint;
  date: string;
  categoryId?: string | null;
  recurringSeriesId: string;
  sourceType: "recurring";
}>;

export type ForecastEventsRepository = Readonly<{
  upsert: (events: NewForecastEvent[], db?: DbTransaction) => Promise<void>;
  listUpcoming: (
    userId: string,
    fromDate: string,
    toDate: string,
  ) => Promise<ForecastEventRow[]>;
  resolve: (
    userId: string,
    eventId: string,
    transactionId: string,
  ) => Promise<void>;
  softDeleteFutureSeries: (userId: string, seriesId: string) => Promise<void>;
}>;

async function upsert(
  db: ForecastEventsDb,
  events: NewForecastEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await db
    .insert(schema.forecastEvents)
    .values(
      events.map((event) => ({
        userId: event.userId,
        accountId: event.accountId ?? null,
        name: event.name,
        amount: event.amountCents,
        date: event.date,
        categoryId: event.categoryId ?? null,
        recurringSeriesId: event.recurringSeriesId,
        sourceType: event.sourceType,
      })),
    )
    .onConflictDoNothing({
      target: [
        schema.forecastEvents.userId,
        schema.forecastEvents.recurringSeriesId,
        schema.forecastEvents.date,
      ],
      where: sql`bill_occurrence_id IS NULL`,
    });
}

async function listUpcoming(
  db: ForecastEventsDb,
  userId: string,
  fromDate: string,
  toDate: string,
): Promise<ForecastEventRow[]> {
  return db
    .select()
    .from(schema.forecastEvents)
    .where(
      and(
        eq(schema.forecastEvents.userId, userId),
        isNull(schema.forecastEvents.deletedAt),
        isNull(schema.forecastEvents.resolvedToTransactionId),
        gte(schema.forecastEvents.date, fromDate),
        lte(schema.forecastEvents.date, toDate),
      ),
    )
    .orderBy(schema.forecastEvents.date);
}

async function resolve(
  db: ForecastEventsDb,
  userId: string,
  eventId: string,
  transactionId: string,
): Promise<void> {
  await db
    .update(schema.forecastEvents)
    .set({ resolvedToTransactionId: transactionId, updatedAt: new Date() })
    .where(
      and(
        eq(schema.forecastEvents.userId, userId),
        eq(schema.forecastEvents.id, eventId),
      ),
    );
}

async function softDeleteFutureSeries(
  db: ForecastEventsDb,
  userId: string,
  seriesId: string,
): Promise<void> {
  await db
    .update(schema.forecastEvents)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.forecastEvents.userId, userId),
        eq(schema.forecastEvents.recurringSeriesId, seriesId),
        isNull(schema.forecastEvents.resolvedToTransactionId),
        isNull(schema.forecastEvents.deletedAt),
        sql`${schema.forecastEvents.date} >= CURRENT_DATE`,
      ),
    );
}

export const forecastEventsRepository: ForecastEventsRepository = {
  upsert: (events, db) => upsert(db ?? getDb(), events),
  listUpcoming: (userId, fromDate, toDate) =>
    listUpcoming(getDb(), userId, fromDate, toDate),
  resolve: (userId, eventId, transactionId) =>
    resolve(getDb(), userId, eventId, transactionId),
  softDeleteFutureSeries: (userId, seriesId) =>
    softDeleteFutureSeries(getDb(), userId, seriesId),
};

/** Binds event persistence to an explicit database client for integration tests. */
export function createForecastEventsRepository(
  db: Db,
): ForecastEventsRepository {
  return {
    upsert: (events, tx) => upsert(tx ?? db, events),
    listUpcoming: (userId, fromDate, toDate) =>
      listUpcoming(db, userId, fromDate, toDate),
    resolve: (userId, eventId, transactionId) =>
      resolve(db, userId, eventId, transactionId),
    softDeleteFutureSeries: (userId, seriesId) =>
      softDeleteFutureSeries(db, userId, seriesId),
  };
}
