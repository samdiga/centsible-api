import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../../../database/schema/index.js";
import { createResponseCache } from "../../../src/platform/cache/response-cache.js";
import {
  createWithUserMutation,
  getUserRevision,
  incrementUserRevision,
} from "../../../src/platform/cache/user-revisions.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

function hasExternalTestDatabaseApproval(): boolean {
  try {
    readTestDatabaseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

async function insertUser(
  db: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"],
  userId: string,
  name = "Revision Test",
): Promise<void> {
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name,
  });
}

const guardedDescribe = hasExternalTestDatabaseApproval()
  ? describe
  : describe.skip;

guardedDescribe("isolated user data versions", () => {
  it("migrates a bigint user revision table with cascade and atomic increments", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userId = randomUUID();

    try {
      await insertUser(testDb.db, userId);
      expect(await getUserRevision(userId, testDb.db)).toBe(0n);

      const first = await testDb.db.transaction((tx) =>
        incrementUserRevision(userId, tx),
      );
      const second = await testDb.db.transaction((tx) =>
        incrementUserRevision(userId, tx),
      );
      const concurrent = await Promise.all([
        testDb.db.transaction((tx) => incrementUserRevision(userId, tx)),
        testDb.db.transaction((tx) => incrementUserRevision(userId, tx)),
      ]);

      expect(first).toBe(1n);
      expect(second).toBe(2n);
      expect(
        [...concurrent].sort((left, right) => Number(left - right)),
      ).toEqual([3n, 4n]);
      expect(await getUserRevision(userId, testDb.db)).toBe(4n);

      const columns = await testDb.db.execute(
        sql<
          {
            column_default: string | null;
            column_name: string;
            data_type: string;
            is_nullable: "YES" | "NO";
          }[]
        >`
          select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'user_data_versions'
          order by ordinal_position
        `,
      );
      expect(columns).toEqual([
        expect.objectContaining({
          column_name: "user_id",
          data_type: "uuid",
          is_nullable: "NO",
        }),
        expect.objectContaining({
          column_name: "revision",
          data_type: "bigint",
          is_nullable: "NO",
          column_default: expect.stringContaining("1"),
        }),
        expect.objectContaining({
          column_name: "updated_at",
          data_type: "timestamp with time zone",
          is_nullable: "NO",
          column_default: expect.stringContaining("now"),
        }),
      ]);

      await testDb.db.delete(users).where(eq(users.id, userId));
      expect(await getUserRevision(userId, testDb.db)).toBe(0n);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("commits user mutations with revisions, rolls both back, and rejects stale revision keys", async () => {
    const testDb = await createIsolatedTestDatabase();
    const committedUserId = randomUUID();
    const rolledBackUserId = randomUUID();
    const missedNotificationUserId = randomUUID();

    try {
      await insertUser(testDb.db, committedUserId, "Before");
      await insertUser(testDb.db, missedNotificationUserId);
      const evicted: string[] = [];
      const publishedRevisions: bigint[] = [];
      const withUserMutation = createWithUserMutation({
        db: testDb.db,
        cache: { invalidateUser: (userId) => evicted.push(userId) },
        publishInvalidation: async (userId) => {
          publishedRevisions.push(await getUserRevision(userId, testDb.db));
        },
      });

      await expect(
        withUserMutation(committedUserId, async (tx) => {
          await tx
            .update(users)
            .set({ name: "After" })
            .where(eq(users.id, committedUserId));
          return "committed";
        }),
      ).resolves.toBe("committed");
      expect(await getUserRevision(committedUserId, testDb.db)).toBe(1n);
      expect(publishedRevisions).toEqual([1n]);
      expect(evicted).toEqual([committedUserId]);

      await expect(
        testDb.db.transaction(async (tx) => {
          await insertUser(tx, rolledBackUserId);
          await incrementUserRevision(rolledBackUserId, tx);
          throw new Error("rollback both");
        }),
      ).rejects.toThrow("rollback both");
      expect(await getUserRevision(rolledBackUserId, testDb.db)).toBe(0n);
      const rolledBackUsers = await testDb.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, rolledBackUserId));
      expect(rolledBackUsers).toEqual([]);

      const cache = createResponseCache();
      const staleKey = {
        userId: missedNotificationUserId,
        method: "GET" as const,
        route: "/accounts",
        query: {},
        revision: 0n,
      };
      await cache.getOrCompute(staleKey, async () => "old response");
      await testDb.db.transaction((tx) =>
        incrementUserRevision(missedNotificationUserId, tx),
      );
      const currentRevision = await getUserRevision(
        missedNotificationUserId,
        testDb.db,
      );
      await expect(
        cache.getOrCompute(
          { ...staleKey, revision: currentRevision },
          async () => "new response",
        ),
      ).resolves.toBe("new response");
      expect(cache.stats()).toMatchObject({ userInvalidations: 1 });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
