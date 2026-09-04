import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { categories, users } from "../../../database/schema/index.js";
import {
  createCategoryRepository,
  type CategoryRow,
} from "../../../src/modules/categories/categories.repository.js";
import {
  readTestDatabaseConfig,
  createIsolatedTestDatabase,
} from "../../support/test-database.js";

function hasExternalTestDatabaseApproval(): boolean {
  try {
    readTestDatabaseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

const guardedDescribe = hasExternalTestDatabaseApproval()
  ? describe
  : describe.skip;

async function insertUser(
  db: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"],
  userId: string,
): Promise<void> {
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Category Test User",
  });
}

async function insertCategory(
  db: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"],
  values: Partial<typeof categories.$inferInsert> & {
    name: string;
  },
): Promise<CategoryRow> {
  const rows = await db
    .insert(categories)
    .values({ id: randomUUID(), ...values })
    .returning();
  return rows[0]!;
}

guardedDescribe("isolated category repository", () => {
  it("enforces global and user visibility while excluding archived rows", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userOne = randomUUID();
    const userTwo = randomUUID();

    try {
      await insertUser(testDb.db, userOne);
      await insertUser(testDb.db, userTwo);
      const systemRoot = await insertCategory(testDb.db, {
        name: "Housing",
        userId: null,
        parentId: null,
      });
      const systemChild = await insertCategory(testDb.db, {
        name: "Rent",
        userId: null,
        parentId: systemRoot.id,
      });
      const ownCategory = await insertCategory(testDb.db, {
        name: "Dining",
        userId: userOne,
        parentId: null,
      });
      const otherCategory = await insertCategory(testDb.db, {
        name: "Private",
        userId: userTwo,
        parentId: null,
      });
      const archived = await insertCategory(testDb.db, {
        name: "Archived",
        userId: userOne,
        parentId: null,
        archivedAt: new Date(),
      });
      const repository = createCategoryRepository(testDb.db);

      const visible = await repository.listCategories(userOne);
      expect(visible.map(({ id }) => id)).toEqual(
        expect.arrayContaining([systemRoot.id, systemChild.id, ownCategory.id]),
      );
      expect(visible.map(({ id }) => id)).not.toContain(otherCategory.id);
      expect(visible.map(({ id }) => id)).not.toContain(archived.id);
      await expect(
        repository.getCategoryById(userOne, otherCategory.id),
      ).resolves.toBeNull();
      await expect(
        repository.getCategoryById(userOne, archived.id),
      ).resolves.toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("allows system mutations, scopes user mutations, and soft-archives rows", async () => {
    const testDb = await createIsolatedTestDatabase();
    const owner = randomUUID();
    const otherUser = randomUUID();

    try {
      await insertUser(testDb.db, owner);
      await insertUser(testDb.db, otherUser);
      const systemCategory = await insertCategory(testDb.db, {
        name: "System",
        userId: null,
        parentId: null,
      });
      const ownCategory = await insertCategory(testDb.db, {
        name: "Own",
        userId: owner,
        parentId: null,
      });
      const repository = createCategoryRepository(testDb.db);

      await expect(
        repository.updateCategory(otherUser, systemCategory.id, {
          name: "System Renamed",
        }),
      ).resolves.toMatchObject({
        id: systemCategory.id,
        name: "System Renamed",
      });
      await expect(
        repository.updateCategory(otherUser, ownCategory.id, {
          name: "Stolen",
        }),
      ).resolves.toBeNull();
      await expect(
        repository.archiveCategory(otherUser, ownCategory.id),
      ).resolves.toBeNull();
      await expect(
        repository.archiveCategory(owner, ownCategory.id),
      ).resolves.toMatchObject({
        id: ownCategory.id,
        archivedAt: expect.any(Date),
      });
      await expect(
        repository.getCategoryById(owner, ownCategory.id),
      ).resolves.toBeNull();

      const storedSystem = await testDb.db
        .select({ name: categories.name })
        .from(categories)
        .where(
          and(eq(categories.id, systemCategory.id), isNull(categories.userId)),
        );
      expect(storedSystem).toEqual([{ name: "System Renamed" }]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
