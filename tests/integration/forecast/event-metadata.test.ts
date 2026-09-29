import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
  forecastEvents,
  tags,
  transactionTags,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { getAccountForecastInputs } from "../../../src/modules/forecast/forecast-accounts.repository.js";
import { createForecastRepository } from "../../../src/modules/forecast/forecast.repository.js";
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

guardedDescribe("forecast event category and tags", () => {
  it("maps v1 and v2 sources while excluding another user's tag IDs", async () => {
    const fixture = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const otherUserId = randomUUID();
      const accountId = randomUUID();
      const otherAccountId = randomUUID();
      const categoryId = randomUUID();
      const tagId = randomUUID();
      const otherTagId = randomUUID();
      const transactionId = randomUUID();
      const otherTransactionId = randomUUID();
      const eventId = randomUUID();
      const today = "2026-09-29";
      const date = "2026-09-30";

      await fixture.db.insert(users).values(
        [userId, otherUserId].map((id) => ({
          id,
          name: "Fixture",
          email: `${id}@example.test`,
        })),
      );
      await fixture.db.insert(accounts).values([
        {
          id: accountId,
          userId,
          name: "Checking",
          type: "depository",
          subtype: "checking",
          currentBalance: 10_000n,
        },
        {
          id: otherAccountId,
          userId: otherUserId,
          name: "Other",
          type: "depository",
          subtype: "checking",
          currentBalance: 10_000n,
        },
      ]);
      await fixture.db
        .insert(categories)
        .values({ id: categoryId, userId, name: "Utilities" });
      await fixture.db.insert(tags).values([
        { id: tagId, userId, name: "Own" },
        { id: otherTagId, userId: otherUserId, name: "Private" },
      ]);
      await fixture.db.insert(forecastEvents).values({
        id: eventId,
        userId,
        accountId,
        name: "Recurring",
        amount: 500n,
        date,
        categoryId,
        sourceType: "recurring",
      });
      await fixture.db.insert(transactions).values([
        {
          id: transactionId,
          userId,
          accountId,
          name: "Pending",
          amount: 200n,
          date,
          categoryId,
          status: "pending",
        },
        {
          id: otherTransactionId,
          userId: otherUserId,
          accountId: otherAccountId,
          name: "Other",
          amount: 300n,
          date,
          status: "pending",
        },
      ]);
      await fixture.db.insert(transactionTags).values([
        { transactionId, tagId },
        { transactionId, tagId: otherTagId },
        { transactionId: otherTransactionId, tagId: otherTagId },
      ]);

      const v1 = await createForecastRepository(fixture.db).getForecastInputs(
        userId,
        14,
        today,
      );
      const v2 = await getAccountForecastInputs(userId, 14, today, fixture.db);
      for (const events of [v1.events, v2.events]) {
        expect(
          events.find((event) => event.sourceId === eventId),
        ).toMatchObject({ categoryId, tagIds: [] });
        expect(
          events.find((event) => event.sourceId === transactionId),
        ).toMatchObject({ categoryId, tagIds: [tagId] });
        expect(
          events.some((event) => event.sourceId === otherTransactionId),
        ).toBe(false);
        expect(events.flatMap((event) => event.tagIds ?? [])).not.toContain(
          otherTagId,
        );
      }
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});
