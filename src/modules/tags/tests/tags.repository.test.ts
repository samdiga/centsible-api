import { describe, expect, it } from "vitest";

import { ConflictError } from "../../../platform/errors/app-error.js";
import { tagRepository, type TagDb } from "../tags.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TAG_ID = "22222222-2222-4222-8222-222222222222";

/**
 * A minimal fake `Db` whose insert/update chains reject with whatever error
 * is supplied, so the repository's unique-violation detection can be
 * exercised against error shapes it will actually see in production —
 * notably drizzle-orm's `DrizzleQueryError`, which wraps the real `pg`
 * error one level down as `.cause` rather than exposing `.code` directly.
 */
function fakeDb(rejection: unknown): TagDb {
  return {
    insert: () => ({
      values: () => ({
        returning: () => Promise.reject(rejection),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.reject(rejection),
        }),
      }),
    }),
  } as unknown as TagDb;
}

/** Shape produced by drizzle-orm 0.45.x's DrizzleQueryError wrapper. */
function wrappedPgError(code: string) {
  return {
    query: "insert into tags ...",
    params: [],
    cause: { code },
  };
}

describe("tags repository isUniqueViolation (via insertTag/updateTag)", () => {
  it("maps a drizzle-wrapped 23505 on insert to ConflictError", async () => {
    const db = fakeDb(wrappedPgError("23505"));
    await expect(
      tagRepository.insertTag(USER_ID, { name: "Groceries", color: null }, db),
    ).rejects.toThrow(ConflictError);
  });

  it("maps a drizzle-wrapped 23505 on update to ConflictError", async () => {
    const db = fakeDb(wrappedPgError("23505"));
    await expect(
      tagRepository.updateTag(USER_ID, TAG_ID, { name: "Groceries" }, db),
    ).rejects.toThrow(ConflictError);
  });

  it("does not treat an unrelated wrapped error as a unique violation", async () => {
    const db = fakeDb(wrappedPgError("23503"));
    await expect(
      tagRepository.insertTag(USER_ID, { name: "Groceries", color: null }, db),
    ).rejects.not.toThrow(ConflictError);
  });

  it("does not treat a top-level-only error code (old shallow shape) that lacks it as a false negative regression surface", async () => {
    // Also still recognizes an unwrapped, top-level 23505 (defensive: some
    // drivers/paths may not wrap at all).
    const db = fakeDb({ code: "23505" });
    await expect(
      tagRepository.insertTag(USER_ID, { name: "Groceries", color: null }, db),
    ).rejects.toThrow(ConflictError);
  });

  it("rethrows a plain, non-Postgres error unchanged", async () => {
    const boom = new Error("connection reset");
    const db = fakeDb(boom);
    await expect(
      tagRepository.insertTag(USER_ID, { name: "Groceries", color: null }, db),
    ).rejects.toBe(boom);
  });
});
