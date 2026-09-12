import { NotFoundError } from "../../platform/errors/app-error.js";
import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import { getUserRevision } from "../../platform/cache/user-revisions.repository.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { tagRepository, type TagRepository } from "./tags.repository.js";
import { toTagDto } from "./tags.mapper.js";
import type { CreateTagInput, TagDto, UpdateTagInput } from "./tags.schemas.js";

export type TagService = Readonly<{
  listTags: (userId: string) => Promise<TagDto[]>;
  createTag: (userId: string, input: CreateTagInput) => Promise<TagDto>;
  updateTag: (userId: string, id: string, input: UpdateTagInput) => Promise<TagDto>;
  deleteTag: (userId: string, id: string) => Promise<boolean>;
}>;

export type TagServiceDependencies = Readonly<{
  repository?: TagRepository;
  cache?: TagCache;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
}>;

export type TagCache = Pick<ResponseCache, "getOrCompute" | "invalidateUser">;

export type { TagRepository } from "./tags.repository.js";

type Mutation = <T>(
  userId: string,
  callback: (tx: DbTransaction) => Promise<T>,
) => Promise<T>;

function defaultWithUserMutation(
  cache: Pick<ResponseCache, "invalidateUser">,
): UserMutationService["withUserMutation"] {
  return createWithUserMutation({ db: getDb(), cache });
}

export function createTagService(
  dependencies: TagServiceDependencies = {},
): TagService {
  const repository = dependencies.repository ?? tagRepository;
  if (typeof repository.recordAudit !== "function") {
    throw new Error("Tags audit capability is required");
  }
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    (async (userId: string) => getUserRevision(userId, getDb()));
  const suppliedMutation = dependencies.withUserMutation;

  const mutate: Mutation = suppliedMutation
    ? suppliedMutation
    : (userId, callback) => defaultWithUserMutation(cache)(userId, callback);

  return {
    async listTags(userId) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        { userId, method: "GET", route: "/tags", query: {}, revision },
        async () => {
          const rows = await repository.listTags(userId);
          return rows.map(toTagDto);
        },
      );
    },

    async createTag(userId, input) {
      const created = await mutate(userId, async (tx) => {
        const row = await repository.insertTag(
          userId,
          { name: input.name, color: input.color ?? null },
          tx,
        );
        await repository.recordAudit(
          { userId, entityId: row.id, action: "create", source: "tags.create", after: row },
          tx,
        );
        return row;
      });
      return toTagDto(created);
    },

    async updateTag(userId, id, input) {
      const existing = await repository.getTagById(userId, id);
      if (!existing) throw new NotFoundError("tag");
      const updateData: Parameters<TagRepository["updateTag"]>[2] = {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.color !== undefined) updateData.color = input.color;
      const updated = await mutate(userId, async (tx) => {
        const row = await repository.updateTag(userId, id, updateData, tx);
        if (!row) throw new NotFoundError("tag");
        await repository.recordAudit(
          {
            userId,
            entityId: id,
            action: "update",
            source: "tags.update",
            before: existing,
            after: row,
          },
          tx,
        );
        return row;
      });
      return toTagDto(updated);
    },

    async deleteTag(userId, id) {
      const existing = await repository.getTagById(userId, id);
      if (!existing) throw new NotFoundError("tag");
      await mutate(userId, async (tx) => {
        const deleted = await repository.deleteTag(userId, id, tx);
        if (!deleted) throw new NotFoundError("tag");
        await repository.recordAudit(
          { userId, entityId: id, action: "delete", source: "tags.delete", before: existing },
          tx,
        );
      });
      return true;
    },
  };
}
