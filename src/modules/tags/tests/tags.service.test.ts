import { describe, expect, it, vi } from "vitest";

import { NotFoundError } from "../../../platform/errors/app-error.js";
import { createWithUserMutation } from "../../../platform/cache/user-revisions.repository.js";
import { createResponseCache } from "../../../platform/cache/response-cache.js";
import type { Db, DbTransaction } from "../../../platform/database/types.js";
import { createTagService, type TagRepository } from "../tags.service.js";
import type { TagRow } from "../tags.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TAG_ID = "22222222-2222-4222-8222-222222222222";

const row: TagRow = {
  id: TAG_ID,
  userId: USER_ID,
  name: "Dining",
  color: "#123456",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
};

function repository(): TagRepository {
  return {
    listTags: vi.fn(async () => [row]),
    getTagById: vi.fn(async () => row),
    tagsExist: vi.fn(async () => true),
    insertTag: vi.fn(async () => row),
    updateTag: vi.fn(async () => ({ ...row, name: "Food" })),
    deleteTag: vi.fn(async () => true),
    recordAudit: vi.fn(async () => undefined),
  };
}

function transactionDb(): Pick<Db, "transaction"> {
  return {
    transaction: async <T>(callback: (tx: DbTransaction) => Promise<T>) =>
      callback({} as DbTransaction),
  } as Pick<Db, "transaction">;
}

describe("tags service", () => {
  it("maps persistence rows to tag DTOs when listing", async () => {
    const repo = repository();
    const service = createTagService({ repository: repo, getUserRevision: async () => 0n });

    await expect(service.listTags(USER_ID)).resolves.toEqual([
      { id: TAG_ID, name: "Dining", color: "#123456", createdAt: "2026-09-01T00:00:00.000Z" },
    ]);
  });

  it("caches a user's tag list and reuses the cached response", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const service = createTagService({ repository: repo, cache, getUserRevision: async () => 1n });

    await service.listTags(USER_ID);
    await service.listTags(USER_ID);

    expect(repo.listTags).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("invalidates the cached list after a committed create", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const withUserMutation = createWithUserMutation({
      db: transactionDb(),
      cache,
      incrementRevision: async () => 2n,
      publishInvalidation: async () => undefined,
    });
    const service = createTagService({
      repository: repo,
      cache,
      withUserMutation,
      getUserRevision: async () => 1n,
    });

    await service.listTags(USER_ID);
    await service.createTag(USER_ID, { name: "Dining" });

    expect(cache.stats().userInvalidations).toBe(1);
  });

  it("runs create inside withUserMutation, records audit, and passes null color through", async () => {
    const repo = repository();
    const tx = { marker: "tx" };
    const withUserMutation = vi.fn(async (_userId, mutate) => mutate(tx as never));
    const service = createTagService({ repository: repo, withUserMutation });

    await service.createTag(USER_ID, { name: "Dining" });

    expect(withUserMutation).toHaveBeenCalledTimes(1);
    expect(repo.insertTag).toHaveBeenCalledWith(
      USER_ID,
      { name: "Dining", color: null },
      tx,
    );
    expect(repo.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, action: "create", source: "tags.create" }),
      tx,
    );
  });

  it("throws a typed not-found error and does not mutate a missing tag", async () => {
    const repo = repository();
    vi.mocked(repo.getTagById).mockResolvedValue(null);
    const withUserMutation = vi.fn();
    const service = createTagService({ repository: repo, withUserMutation });

    await expect(
      service.updateTag(USER_ID, TAG_ID, { name: "Food" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(withUserMutation).not.toHaveBeenCalled();
  });

  it("runs update and delete inside withUserMutation with before/after audit", async () => {
    const repo = repository();
    const tx = { marker: "tx" };
    const withUserMutation = vi.fn(async (_userId, mutate) => mutate(tx as never));
    const service = createTagService({ repository: repo, withUserMutation });

    await service.updateTag(USER_ID, TAG_ID, { name: "Food" });
    await service.deleteTag(USER_ID, TAG_ID);

    expect(withUserMutation).toHaveBeenCalledTimes(2);
    expect(repo.updateTag).toHaveBeenCalledWith(USER_ID, TAG_ID, { name: "Food" }, tx);
    expect(repo.deleteTag).toHaveBeenCalledWith(USER_ID, TAG_ID, tx);
    expect(repo.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", source: "tags.delete" }),
      tx,
    );
  });

  it("throws when delete finds nothing to remove", async () => {
    const repo = repository();
    vi.mocked(repo.deleteTag).mockResolvedValue(false);
    const withUserMutation = vi.fn(async (_userId, mutate) => mutate({} as never));
    const service = createTagService({ repository: repo, withUserMutation });

    await expect(service.deleteTag(USER_ID, TAG_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an injected repository without the mandatory audit capability", () => {
    const incompleteRepository = { ...repository(), recordAudit: undefined } as unknown as TagRepository;

    expect(() => createTagService({ repository: incompleteRepository })).toThrow(
      "Tags audit capability is required",
    );
  });
});
