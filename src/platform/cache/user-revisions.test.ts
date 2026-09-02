import { describe, expect, it } from "vitest";
import type { Db, DbTransaction } from "../database/types.js";
import {
  USER_DATA_CHANGED_CHANNEL,
  createUserInvalidationListener,
  createWithUserMutation,
} from "./user-revisions.repository.js";

const USER_ID = "33333333-3333-4333-8333-333333333333";

function transactionDb(order: string[]): Pick<Db, "transaction"> {
  return {
    transaction: async <T>(callback: (tx: DbTransaction) => Promise<T>) => {
      const result = await callback({} as DbTransaction);
      order.push("commit");
      return result;
    },
  } as Pick<Db, "transaction">;
}

describe("user mutation invalidation", () => {
  it("commits mutation and revision before locally evicting then publishing only the internal user ID", async () => {
    const order: string[] = [];
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: {
        invalidateUser(userId) {
          order.push(`evict:${userId}`);
        },
      },
      incrementRevision: async (userId) => {
        order.push(`revision:${userId}`);
        return 1n;
      },
      publishInvalidation: async (userId) => {
        order.push(`publish:${userId}`);
      },
    });

    const result = await withUserMutation(USER_ID, async () => {
      order.push("mutate");
      return { committed: true };
    });

    expect(result).toEqual({ committed: true });
    expect(order).toEqual([
      "mutate",
      `revision:${USER_ID}`,
      "commit",
      `evict:${USER_ID}`,
      `publish:${USER_ID}`,
    ]);
  });

  it("does not evict or publish when the transaction rolls back", async () => {
    const order: string[] = [];
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: { invalidateUser: (userId) => order.push(`evict:${userId}`) },
      incrementRevision: async (userId) => {
        order.push(`revision:${userId}`);
        return 1n;
      },
      publishInvalidation: async (userId) => {
        order.push(`publish:${userId}`);
      },
    });

    await expect(
      withUserMutation(USER_ID, async () => {
        order.push("mutate");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(order).toEqual(["mutate"]);
  });

  it("returns a committed mutation when publishing fails and reports the failure safely", async () => {
    const order: string[] = [];
    const publishError = new Error("notification unavailable");
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: { invalidateUser: (userId) => order.push(`evict:${userId}`) },
      incrementRevision: async (userId) => {
        order.push(`revision:${userId}`);
        return 1n;
      },
      publishInvalidation: async (userId) => {
        order.push(`publish:${userId}`);
        throw publishError;
      },
      onPublishError: (error, userId) => {
        expect(error).toBe(publishError);
        order.push(`report:${userId}`);
      },
    });

    await expect(
      withUserMutation(USER_ID, async () => {
        order.push("mutate");
        return "committed";
      }),
    ).resolves.toBe("committed");
    expect(order).toEqual([
      "mutate",
      `revision:${USER_ID}`,
      "commit",
      `evict:${USER_ID}`,
      `publish:${USER_ID}`,
      `report:${USER_ID}`,
    ]);
  });
});

describe("user invalidation listener", () => {
  it("has no subscription side effect until started and ignores malformed payloads", async () => {
    const invalidated: string[] = [];
    const invalidPayloads: string[] = [];
    const channels: string[] = [];
    let notify: ((payload: string) => void) | undefined;
    let stopped = 0;
    const listener = createUserInvalidationListener({
      cache: { invalidateUser: (userId) => invalidated.push(userId) },
      listen: async (channel, onNotification) => {
        channels.push(channel);
        notify = onNotification;
        return { unlisten: async () => void (stopped += 1) };
      },
      onInvalidPayload: (payload) => invalidPayloads.push(payload),
    });

    expect(channels).toEqual([]);
    await listener.start();
    notify?.("not-a-uuid");
    notify?.(USER_ID);
    await listener.stop();
    await listener.stop();

    expect(channels).toEqual([USER_DATA_CHANGED_CHANNEL]);
    expect(invalidated).toEqual([USER_ID]);
    expect(invalidPayloads).toEqual(["not-a-uuid"]);
    expect(stopped).toBe(1);
  });
});
