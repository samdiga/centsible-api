import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  transactionTags,
  transactions,
  accounts,
  users,
} from "../../../database/schema/index.js";
import { createTagRepository } from "../../../src/modules/tags/tags.repository.js";
import { ConflictError } from "../../../src/platform/errors/app-error.js";
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
    name: "Tag Test User",
  });
}

guardedDescribe("isolated tag repository", () => {
  it("scopes tags to their owner and orders by name case-insensitively", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userOne = randomUUID();
    const userTwo = randomUUID();

    try {
      await insertUser(testDb.db, userOne);
      await insertUser(testDb.db, userTwo);
      const repository = createTagRepository(testDb.db);

      await repository.insertTag(userOne, { name: "zebra", color: null });
      await repository.insertTag(userOne, { name: "Apple", color: "#10b981" });
      await repository.insertTag(userTwo, { name: "Private", color: null });

      const visible = await repository.listTags(userOne);
      expect(visible.map((t) => t.name)).toEqual(["Apple", "zebra"]);
      expect(visible.every((t) => t.userId === userOne)).toBe(true);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("rejects a duplicate name for the same user, allows it for another user", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userOne = randomUUID();
    const userTwo = randomUUID();

    try {
      await insertUser(testDb.db, userOne);
      await insertUser(testDb.db, userTwo);
      const repository = createTagRepository(testDb.db);

      await repository.insertTag(userOne, { name: "Dining", color: null });
      await expect(
        repository.insertTag(userOne, { name: "Dining", color: null }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        repository.insertTag(userTwo, { name: "Dining", color: null }),
      ).resolves.toMatchObject({ name: "Dining" });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("does not treat renaming a tag to its current name as a conflict", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userId = randomUUID();

    try {
      await insertUser(testDb.db, userId);
      const repository = createTagRepository(testDb.db);
      const tag = await repository.insertTag(userId, {
        name: "Dining",
        color: null,
      });

      await expect(
        repository.updateTag(userId, tag.id, { name: "Dining" }),
      ).resolves.toMatchObject({ id: tag.id, name: "Dining" });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("refuses to update or delete another user's tag", async () => {
    const testDb = await createIsolatedTestDatabase();
    const owner = randomUUID();
    const otherUser = randomUUID();

    try {
      await insertUser(testDb.db, owner);
      await insertUser(testDb.db, otherUser);
      const repository = createTagRepository(testDb.db);
      const tag = await repository.insertTag(owner, {
        name: "Dining",
        color: null,
      });

      await expect(
        repository.updateTag(otherUser, tag.id, { name: "Stolen" }),
      ).resolves.toBeNull();
      await expect(repository.deleteTag(otherUser, tag.id)).resolves.toBe(
        false,
      );
      await expect(repository.getTagById(owner, tag.id)).resolves.toMatchObject(
        {
          name: "Dining",
        },
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("cascades delete to transaction_tags rows", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userId = randomUUID();
    const accountId = randomUUID();
    const transactionId = randomUUID();

    try {
      await insertUser(testDb.db, userId);
      await testDb.db.insert(accounts).values({
        id: accountId,
        userId,
        plaidAccountId: `plaid-${randomUUID()}`,
        name: "Checking",
        type: "depository",
        subtype: "checking",
      });
      await testDb.db.insert(transactions).values({
        id: transactionId,
        userId,
        accountId,
        plaidTransactionId: `transaction-${randomUUID()}`,
        name: "Coffee",
        amount: 500n,
        date: "2026-09-04",
      });
      const repository = createTagRepository(testDb.db);
      const tag = await repository.insertTag(userId, {
        name: "Dining",
        color: null,
      });
      await testDb.db
        .insert(transactionTags)
        .values({ transactionId, tagId: tag.id });

      await expect(repository.deleteTag(userId, tag.id)).resolves.toBe(true);

      const remaining = await testDb.db
        .select()
        .from(transactionTags)
        .where(eq(transactionTags.tagId, tag.id));
      expect(remaining).toHaveLength(0);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("tagsExist is vacuously true for an empty list and checks ownership otherwise", async () => {
    const testDb = await createIsolatedTestDatabase();
    const owner = randomUUID();
    const otherUser = randomUUID();

    try {
      await insertUser(testDb.db, owner);
      await insertUser(testDb.db, otherUser);
      const repository = createTagRepository(testDb.db);
      const ownTag = await repository.insertTag(owner, {
        name: "Dining",
        color: null,
      });
      const otherTag = await repository.insertTag(otherUser, {
        name: "Private",
        color: null,
      });

      await expect(repository.tagsExist(owner, [])).resolves.toBe(true);
      await expect(repository.tagsExist(owner, [ownTag.id])).resolves.toBe(
        true,
      );
      await expect(
        repository.tagsExist(owner, [ownTag.id, otherTag.id]),
      ).resolves.toBe(false);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
