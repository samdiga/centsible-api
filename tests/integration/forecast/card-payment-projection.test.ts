import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accounts, billSetup, users } from "../../../database/schema/index.js";
import { projectCardPayments } from "../../../src/modules/forecast/card-payment-projection.js";
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

guardedDescribe("card payment projection", () => {
  it("projects each card statement due by the period end with its payment rule", async () => {
    const fixture = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const checking = randomUUID();
      const full = randomUUID();
      const planned = randomUUID();
      const later = randomUUID();
      await fixture.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      const card = (
        id: string,
        name: string,
        paymentDueDate: string,
        fields: Partial<typeof accounts.$inferInsert> = {},
      ) => ({
        id,
        userId,
        name,
        type: "credit" as const,
        subtype: "credit_card" as const,
        currentBalance: 90_000n,
        statementBalance: 60_000n,
        statementDate: "2026-09-25",
        paymentDueDate,
        minimumPayment: 2_500n,
        ...fields,
      });
      await fixture.db.insert(accounts).values([
        {
          id: checking,
          userId,
          name: "Checking",
          type: "depository" as const,
          subtype: "checking" as const,
          currentBalance: 500_000n,
        },
        card(full, "Full", "2026-10-20"),
        card(planned, "Planned", "2026-10-22", {
          cardPaymentRule: "planned",
          cardPlannedPaymentCents: 10_000n,
        }),
        card(later, "Later", "2026-11-03"),
      ]);
      await fixture.db.insert(billSetup).values(
        [full, planned, later].map((id, index) => ({
          userId,
          canonicalName: `Card ${index} payment`,
          cadence: "monthly" as const,
          avgAmount: 60_000n,
          status: "active" as const,
          userConfirmed: true,
          billType: "transfer" as const,
          toAccountId: id,
          accountId: checking,
        })),
      );

      const projections = await projectCardPayments(
        userId,
        "2026-10-05",
        "2026-10-31",
        fixture.db,
      );
      expect(
        projections
          .map((p) => [p.cardAccountId, p.dueDate, p.paymentCents])
          .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      ).toEqual([
        [full, "2026-10-20", 60_000n],
        [planned, "2026-10-22", 10_000n],
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});
