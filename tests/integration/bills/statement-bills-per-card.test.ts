import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts, billSetup, users } from "../../../database/schema/index.js";
import { upsertStatementBills } from "../../../src/modules/bills/statement-bills.js";
import { createUserMutationService } from "../../../src/platform/cache/user-revisions.repository.js";
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

guardedDescribe("statement bills, one per card", () => {
  it("gives cards that share Plaid's name their own bills, named for the user's cards", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const me = randomUUID();
      await db.insert(users).values({ id: me, email: `${me}@example.test` });
      const card = (name: string, nameOverride: string | null, mask: string, cents: bigint) => ({
        userId: me,
        name,
        nameOverride,
        mask,
        type: "credit" as const,
        subtype: "credit_card" as const,
        statementBalance: cents,
        statementDate: "2026-10-23",
        paymentDueDate: "2026-11-20",
      });
      const [freedom, prime, ventureA, ventureB] = await db
        .insert(accounts)
        .values([
          card("CREDIT CARD", "Chase Freedom", "3775", 101867n),
          card("CREDIT CARD", "Chase Prime", "2079", 34785n),
          card("Venture X", null, "6494", 17488n),
          card("Venture X", null, "6925", 5000n),
        ])
        .returning();
      // Today's prod shape: one bill per shared name, each held by one card.
      await db.insert(billSetup).values([
        {
          userId: me,
          billType: "transfer",
          toAccountId: freedom!.id,
          canonicalName: "CREDIT CARD payment",
          cadence: "monthly",
          avgAmount: 101867n,
          status: "active",
          userConfirmed: true,
          autoDetected: false,
        },
        {
          userId: me,
          billType: "transfer",
          toAccountId: ventureA!.id,
          canonicalName: "Venture X payment",
          cadence: "monthly",
          avgAmount: 17488n,
          status: "active",
          userConfirmed: true,
          autoDetected: false,
        },
      ]);
      const { withUserMutation } = createUserMutationService({
        db,
        cache: { invalidateUser: () => undefined },
        incrementRevision: async () => 1n,
        publishInvalidation: async () => undefined,
      });
      const bills = async () =>
        Object.fromEntries(
          (await db.select().from(billSetup).where(eq(billSetup.userId, me))).map(
            (row) => [row.toAccountId, row],
          ),
        );

      await expect(upsertStatementBills(me, { db, withUserMutation })).resolves.toEqual({
        created: 2,
        updated: 2,
      });
      const first = await bills();
      expect(Object.keys(first)).toHaveLength(4);
      expect(first[freedom!.id]).toMatchObject({
        canonicalName: "CREDIT CARD payment",
        displayName: "Chase Freedom payment",
        avgAmount: 101867n,
      });
      expect(first[prime!.id]).toMatchObject({
        canonicalName: "Chase Prime payment",
        displayName: null,
        avgAmount: 34785n,
        nextExpectedDate: "2026-11-20",
      });
      expect(first[ventureA!.id]).toMatchObject({
        canonicalName: "Venture X payment",
        displayName: "Venture X ••6494 payment",
        avgAmount: 17488n,
      });
      expect(first[ventureB!.id]).toMatchObject({
        canonicalName: "Venture X ••6925 payment",
        avgAmount: 5000n,
      });

      // Running again changes no card's bill over to another card.
      await expect(upsertStatementBills(me, { db, withUserMutation })).resolves.toEqual({
        created: 0,
        updated: 4,
      });
      const second = await bills();
      for (const id of [freedom!.id, prime!.id, ventureA!.id, ventureB!.id])
        expect(second[id]!.id).toBe(first[id]!.id);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
