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
      await eventsRepository.resolve(userId, events[0]!.id, randomUUID());
      await expect(
        eventsRepository.listUpcoming(userId, eventDate, eventDate),
      ).resolves.toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
