import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  billOccurrences,
  billSetup,
  featureFlags,
  forecastEvents,
  forecastRuns,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createForecastRepository } from "../../../src/modules/forecast/forecast.repository.js";
import { createForecastEventsRepository } from "../../../src/modules/forecast/forecast-events.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

function daysFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

guardedDescribe("forecast repositories", () => {
  it("builds isolated inputs and suppresses actioned bill occurrences", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const setupId = randomUUID();
      const date = daysFromToday(3);
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      await testDb.db.insert(accounts).values({
        id: randomUUID(),
        userId,
        name: "Checking",
        type: "depository",
        subtype: "checking",
        currentBalance: 100_000n,
      });
      await testDb.db.insert(billSetup).values({
        id: setupId,
        userId,
        canonicalName: "Rent",
        cadence: "monthly",
        avgAmount: 10_000n,
        nextExpectedDate: date,
        status: "active",
        userConfirmed: true,
      });
      const [event] = await testDb.db
        .insert(forecastEvents)
        .values({
          userId,
          name: "Rent",
          amount: 10_000n,
          date,
          recurringSeriesId: setupId,
          sourceType: "recurring",
        })
        .returning({ id: forecastEvents.id });
      await testDb.db.insert(billOccurrences).values({
        id: randomUUID(),
        userId,
        billSetupId: setupId,
        occurrenceKey: `${setupId}:${date.slice(0, 7)}`,
        dueDate: date,
        expectedAmountCents: 10_000n,
        status: "paid",
      });

      const repository = createForecastRepository(testDb.db);
      const inputs = await repository.getForecastInputs(
        userId,
        14,
        daysFromToday(0),
      );
      expect(inputs.startingBalanceCents).toBe(100_000n);
      expect(inputs.events.some((input) => input.sourceId === event?.id)).toBe(
        false,
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("uses fail-open defaults and requires both global and user flags", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      const repository = createForecastRepository(testDb.db);
      const flagKey = `test_forecast_${userId}`;
      await expect(repository.isFeatureEnabled(flagKey, userId)).resolves.toBe(
        true,
      );
      await testDb.db.insert(featureFlags).values([
        { flagKey, enabled: true },
        { userId, flagKey, enabled: false },
      ]);
      await expect(repository.isFeatureEnabled(flagKey, userId)).resolves.toBe(
        false,
      );
      await testDb.db
        .update(featureFlags)
        .set({ enabled: true })
        .where(
          and(
            eq(featureFlags.userId, userId),
            eq(featureFlags.flagKey, flagKey),
          ),
        );
      await expect(repository.isFeatureEnabled(flagKey, userId)).resolves.toBe(
        true,
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("keeps only upcoming, overdue, and unmatched forecast events", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      const statuses = [
        "upcoming",
        "overdue",
        "processing",
        "paid",
        "skipped",
        "cancelled",
      ] as const;
      const setups = statuses.map(() => randomUUID());
      const dates = statuses.map((_, index) => daysFromToday(index + 1));
      await testDb.db.insert(billSetup).values(
        setups.map((id, index) => ({
          id,
          userId,
          canonicalName: `Bill ${index}`,
          cadence: "monthly" as const,
          avgAmount: 100n,
          nextExpectedDate: dates[index]!,
          status: "active" as const,
          userConfirmed: true,
        })),
      );
      const eventRows = await testDb.db
        .insert(forecastEvents)
        .values([
          ...setups.map((recurringSeriesId, index) => ({
            userId,
            name: `Event ${index}`,
            amount: 100n,
            date: dates[index]!,
            recurringSeriesId,
            sourceType: "recurring" as const,
          })),
          {
            userId,
            name: "No occurrence",
            amount: 100n,
            date: daysFromToday(8),
            recurringSeriesId: null,
            sourceType: "manual" as const,
          },
        ])
        .returning({ id: forecastEvents.id, name: forecastEvents.name });
      await testDb.db.insert(billOccurrences).values(
        setups.map((billSetupId, index) => ({
          id: randomUUID(),
          userId,
          billSetupId,
          occurrenceKey: `${billSetupId}:${dates[index]!.slice(0, 7)}`,
          dueDate: dates[index]!,
          expectedAmountCents: 100n,
          status: statuses[index]!,
        })),
      );

      const repository = createForecastRepository(testDb.db);
      const inputs = await repository.getForecastInputs(
        userId,
        14,
        daysFromToday(0),
      );
      expect(inputs.events.map((event) => event.name).sort()).toEqual([
        "Event 0",
        "Event 1",
        "No occurrence",
      ]);
      expect(eventRows).toHaveLength(7);
      expect(
        inputs.events.some((event) => event.name === "No occurrence"),
      ).toBe(true);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("serializes bigint forecast run values and exposes event lifecycle operations", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      const eventsRepository = createForecastEventsRepository(testDb.db);
      const seriesId = randomUUID();
      const eventDate = daysFromToday(2);
      const accountId = randomUUID();
      const transactionId = randomUUID();
      await testDb.db.insert(accounts).values({
        id: accountId,
        userId,
        name: "Checking",
        type: "depository",
        subtype: "checking",
        currentBalance: 100_000n,
      });
      await testDb.db.insert(transactions).values({
        id: transactionId,
        userId,
        accountId,
        name: "Subscription",
        amount: 1_250n,
        date: eventDate,
      });
      await testDb.db.insert(billSetup).values({
        id: seriesId,
        userId,
        canonicalName: "Subscription",
        cadence: "monthly",
        avgAmount: 1_250n,
        nextExpectedDate: eventDate,
        status: "active",
        userConfirmed: true,
      });
      await eventsRepository.upsert([
        {
          userId,
          recurringSeriesId: seriesId,
          name: "Subscription",
          amountCents: 1_250n,
          date: eventDate,
          sourceType: "recurring",
        },
      ]);
      const events = await eventsRepository.listUpcoming(
        userId,
        eventDate,
        eventDate,
      );
      expect(events).toHaveLength(1);
      const repository = createForecastRepository(testDb.db);
      const runId = await repository.saveForecastRun(
        userId,
        {
          days: [
            {
              date: eventDate,
              p10Cents: 98_750n,
              p50Cents: 98_750n,
              p90Cents: 98_750n,
              events: [
                {
                  date: eventDate,
                  amountCents: 1_250n,
                  name: "Subscription",
                  confidence: 0.9,
                  sourceType: "recurring",
                },
              ],
            },
          ],
          tightestDay: { date: eventDate, balanceCents: 98_750n },
          algorithmVersion: "v1",
        },
        14,
        100_000n,
      );
      const [run] = await testDb.db
        .select()
        .from(forecastRuns)
        .where(eq(forecastRuns.id, runId));
      expect(run?.startBalance).toBe(100_000n);
      expect(run?.dailyResults[0]?.p50).toBe("98750");
      await eventsRepository.resolve(userId, events[0]!.id, transactionId);
      await expect(
        eventsRepository.listUpcoming(userId, eventDate, eventDate),
      ).resolves.toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("skips empty mature legacy runs so scorable runs are not starved by LIMIT", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      const matureAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const emptyRuns = Array.from({ length: 20 }, () => ({
        userId,
        horizonDays: 1,
        algorithmVersion: "v1",
        startBalance: 100n,
        endBalanceP50: 100n,
        minBalanceP10: 100n,
        minBalanceDate: daysFromToday(-2),
        dailyResults: [],
        createdAt: matureAt,
      }));
      const scoringDate = daysFromToday(-2);
      const insertedRuns = await testDb.db
        .insert(forecastRuns)
        .values([
          ...emptyRuns,
          {
            userId,
            horizonDays: 1,
            algorithmVersion: "v1",
            startBalance: 100n,
            endBalanceP50: 100n,
            minBalanceP10: 100n,
            minBalanceDate: scoringDate,
            dailyResults: [
              {
                date: scoringDate,
                p10: "100",
                p50: "100",
                p90: "100",
                events: [],
              },
            ],
            createdAt: matureAt,
          },
        ])
        .returning({ id: forecastRuns.id });
      const repository = createForecastRepository(testDb.db);
      await expect(repository.computeAndSaveAccuracyBatch()).resolves.toBe(1);
      const runs = await testDb.db
        .select({ id: forecastRuns.id, mape: forecastRuns.mape })
        .from(forecastRuns)
        .where(eq(forecastRuns.userId, userId));
      const validRun = insertedRuns.at(-1);
      expect(runs.find((run) => run.id === validRun?.id)?.mape).toBe(0);
      expect(runs.filter((run) => run.mape === null)).toHaveLength(20);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
